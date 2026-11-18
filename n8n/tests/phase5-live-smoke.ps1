$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $project
$base = 'http://localhost:8080'
$external = 'phase5-smoke-' + [guid]::NewGuid().ToString()
$payload = @{ external_message_id=$external; sender='fictional-billing@example.com'; subject='Fictional duplicate charge'; body='I was charged twice for my fictional account this month.' } | ConvertTo-Json -Compress
$created = Invoke-WebRequest "$base/emails" -Method POST -ContentType 'application/json' -Body $payload -SkipHttpErrorCheck
$email = $created.Content | ConvertFrom-Json -DateKind String
if ($created.StatusCode -ne 201 -or $email.category -ne 'billing' -or $email.assigned_team -ne 'finance' -or [string]::IsNullOrWhiteSpace($email.draft.content)) { throw "Real pipeline failed: HTTP $($created.StatusCode), $($created.Content)" }
Write-Output "create_http=$($created.StatusCode) id=$($email.id) category=$($email.category) team=$($email.assigned_team) draft_chars=$($email.draft.content.Length)"
$stored = Invoke-RestMethod "$base/emails/$($email.id)"
if ($stored.processing_status -ne 'processed' -or $stored.draft.content -ne $email.draft.content) { throw 'Persisted result did not match' }
Write-Output "get_http=200 status=$($stored.processing_status)"
$duplicate = Invoke-WebRequest "$base/emails" -Method POST -ContentType 'application/json' -Body $payload -SkipHttpErrorCheck
$dup = $duplicate.Content | ConvertFrom-Json
if ($duplicate.StatusCode -ne 200 -or $dup.id -ne $email.id) { throw 'Duplicate external message was not idempotent' }
Write-Output "duplicate_http=$($duplicate.StatusCode) same_id=$($dup.id -eq $email.id)"
$invalid = @{ external_message_id='phase5-invalid-' + [guid]::NewGuid().ToString(); sender='fictional@example.com'; subject=''; body='Invalid fixture' } | ConvertTo-Json -Compress
$bad = Invoke-WebRequest "$base/emails" -Method POST -ContentType 'application/json' -Body $invalid -SkipHttpErrorCheck
if ($bad.StatusCode -ne 400) { throw "Invalid email returned $($bad.StatusCode)" }
Write-Output "invalid_api_http=$($bad.StatusCode)"
$unauthorized = Invoke-WebRequest "$base/internal/automation/unresolved" -SkipHttpErrorCheck
if ($unauthorized.StatusCode -ne 401) { throw "Unauthenticated internal request returned $($unauthorized.StatusCode)" }
Write-Output "unauthorized_internal_http=$($unauthorized.StatusCode)"
$hidden = Invoke-WebRequest 'http://localhost:3000/api/internal/automation/unresolved' -SkipHttpErrorCheck
if ($hidden.StatusCode -ne 404) { throw "Next proxy exposed an internal route: $($hidden.StatusCode)" }
Write-Output "next_internal_proxy_http=$($hidden.StatusCode)"
$direct = Invoke-WebRequest 'http://localhost:5678/webhook/mailpilot-intake' -Method POST -ContentType 'application/json' -InFile 'n8n/sample-email.json' -SkipHttpErrorCheck
$result = $direct.Content | ConvertFrom-Json
if ($direct.StatusCode -ne 200 -or $result.category -ne 'billing' -or [string]::IsNullOrWhiteSpace($result.suggested_reply)) { throw "Direct n8n pipeline failed: $($direct.StatusCode) $($direct.Content)" }
Write-Output "direct_webhook_http=$($direct.StatusCode) category=$($result.category)"
$directBad = Invoke-WebRequest 'http://localhost:5678/webhook/mailpilot-intake' -Method POST -ContentType 'application/json' -Body '{"sender":"fictional@example.com","subject":"","body":"Missing subject"}' -SkipHttpErrorCheck
if ($directBad.StatusCode -ne 400) { throw "Direct n8n validation returned $($directBad.StatusCode)" }
Write-Output "direct_invalid_http=$($directBad.StatusCode)"
