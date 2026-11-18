$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $project
$line = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^MAILPILOT_INTERNAL_TOKEN=' } | Select-Object -First 1
if (-not $line) { throw 'MAILPILOT_INTERNAL_TOKEN is missing from .env' }
$token = $line.Substring('MAILPILOT_INTERNAL_TOKEN='.Length).Trim('"', "'")
$headers = @{ 'X-MailPilot-Token' = $token; 'Content-Type' = 'application/json' }
$external = 'phase5-backoff-' + [guid]::NewGuid().ToString()
$sql = "INSERT INTO emails(external_message_id,sender,subject,body) VALUES('$external','backoff-test@example.com','Fictional retry test','This fictional record tests retry backoff.') RETURNING id;"
$output = docker compose exec -T db psql -U mailpilot -d mailpilot -At -c $sql
$id = ($output | Select-Object -First 1).Trim()
if ($id -notmatch '^[0-9a-f-]{36}$') { throw "Could not create test record: $output" }
Write-Output "fixture_id=$id"

for ($attempt = 1; $attempt -le 3; $attempt++) {
  $claimResponse = Invoke-WebRequest -Uri "http://localhost:8080/internal/automation/emails/$id/claim" -Method POST -Headers $headers -Body '{}' -SkipHttpErrorCheck
  if ($claimResponse.StatusCode -ne 200) { throw "Claim $attempt returned $($claimResponse.StatusCode)" }
  $claim = $claimResponse.Content | ConvertFrom-Json
  $completion = @{ claim_token = $claim.claim_token; success = $false; error_code = 'fixture_unavailable' } | ConvertTo-Json -Compress
  $completed = Invoke-WebRequest -Uri "http://localhost:8080/internal/automation/emails/$id/complete" -Method POST -Headers $headers -Body $completion -SkipHttpErrorCheck
  if ($completed.StatusCode -ne 200) { throw "Completion $attempt returned $($completed.StatusCode): $($completed.Content)" }
  $email = (Invoke-WebRequest "http://localhost:8080/emails/$id").Content | ConvertFrom-Json -DateKind String
  $remaining = [math]::Round(([datetimeoffset]::Parse($email.next_retry_at).ToUniversalTime() - [datetimeoffset]::UtcNow).TotalSeconds)
  $blocked = Invoke-WebRequest -Uri "http://localhost:8080/internal/automation/emails/$id/claim" -Method POST -Headers $headers -Body '{}' -SkipHttpErrorCheck
  Write-Output "attempt=$attempt status=$($email.processing_status) next_retry_seconds=$remaining immediate_claim_http=$($blocked.StatusCode)"
  if ($blocked.StatusCode -ne 409) { throw 'Backoff or retry limit was not enforced' }
  if ($attempt -lt 3) {
    docker compose exec -T db psql -U mailpilot -d mailpilot -q -c "UPDATE emails SET next_retry_at=now()-interval '1 second' WHERE id='$id';" | Out-Null
  }
}
$notices = Invoke-RestMethod 'http://localhost:8080/notifications'
$count = @($notices | Where-Object { $_.email_id -eq $id -and $_.type -eq 'retry_exhausted' }).Count
Write-Output "exhausted_notifications=$count"
if ($count -ne 1) { throw 'Expected exactly one exhaustion notification' }
