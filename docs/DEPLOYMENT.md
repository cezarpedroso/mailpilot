# Deploying MailPilot on Vercel and Railway

This guide prepares a private portfolio demo. It does not publish the n8n editor or PostgreSQL, and it does not move OpenRouter credentials out of n8n. Use fresh production secrets and fictional demo emails only.

## Deployment shape

```text
Browser -- HTTPS --> Vercel (Next.js + Auth.js session)
                         | server-side HTTPS + frontend secret
                         v
                    Railway Go API ---- private network ---- Railway PostgreSQL
                         ^
                         | private network + internal callback secret
                    Railway n8n ---- HTTPS ---- OpenRouter
```

The Vercel browser bundle never receives the Go shared secret, n8n callback secret, database URL, or OpenRouter key. `GET /health` is the only unauthenticated Go endpoint. The n8n editor has no public domain in this setup.

## Before deploying

1. Run the local checks from the repository root:

   ```powershell
   docker run --rm -v "${PWD}/services/api:/src" -w /src golang:1.25-alpine sh -c "gofmt -w cmd/api/*.go && go test ./..."
   cd apps/web
   npx tsc --noEmit
   npm run lint
   npm run build
   ```

2. Verify no `.env`, `.env.local`, logs, local n8n backups, or execution exports are staged. The supplied `.gitignore` excludes them.
3. Create a private GitHub repository unless you have independently reviewed the complete history and want it public. Do not push local database data or n8n credentials.

## Environment reference

Generate each secret with a password manager or `openssl rand -hex 32`. Never reuse development values.

| Variable | Service | Secret | Source / purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Go API | Yes | Railway PostgreSQL private connection URL |
| `PORT` | Go API | No | Railway injects this; the API binds to `0.0.0.0:$PORT` |
| `APP_ENV` | Go API | No | Set to `production` |
| `MAILPILOT_FRONTEND_TOKEN` | Go API | Yes | Fresh shared value also set as Vercel `GO_API_SHARED_SECRET` |
| `MAILPILOT_INTERNAL_TOKEN` | Go API, n8n | Yes | Fresh n8n-to-Go callback secret; different from frontend token |
| `N8N_INTAKE_URL` | Go API | No | Private n8n intake URL plus `/webhook/mailpilot-intake` |
| `N8N_SYNC_PROCESSING` | Go API | No | Set `false` in production so Vercel receives a quick `202` and polls |
| `EMAIL_SIMULATION_RATE_LIMIT` | Go API | No | Per demo user requests per minute; default `10` |
| `SLA_HIGH_SECONDS`, `SLA_MEDIUM_SECONDS`, `SLA_LOW_SECONDS` | Go API | No | SLA thresholds, in seconds |
| `MAX_RETRY_ATTEMPTS`, `RETRY_BASE_SECONDS`, `RETRY_LEASE_SECONDS` | Go API | No | Recovery limits and backoff configuration |
| `N8N_ENCRYPTION_KEY` | n8n | Yes | Fresh stable 32+ character encryption key; do not rotate casually |
| `MAILPILOT_API_URL` | n8n | No | Go API private base URL, no trailing slash |
| `MAILPILOT_INTAKE_URL` | n8n | No | n8n's own private base URL, no trailing slash |
| `MAILPILOT_INTERNAL_TOKEN` | n8n | Yes | Must exactly match the Go API callback secret |
| `N8N_HOST`, `N8N_PROTOCOL`, `WEBHOOK_URL` | n8n | No | n8n private service domain and `http`; do not configure a public editor URL |
| `GENERIC_TIMEZONE`, `TZ` | n8n | No | e.g. `America/Chicago` |
| `DB_TYPE`, `DB_POSTGRESDB_*` | n8n | Yes/No | Railway PostgreSQL private connection settings for persistent n8n state |
| `GO_API_URL` | Vercel | No | Public HTTPS Railway Go API URL |
| `GO_API_SHARED_SECRET` | Vercel | Yes | Must match Go `MAILPILOT_FRONTEND_TOKEN`; server-only |
| `AUTH_SECRET` | Vercel | Yes | Fresh Auth.js session secret |
| `MAILPILOT_DEMO_EMAIL` | Vercel | Yes | Authorized demo user login name |
| `MAILPILOT_DEMO_PASSWORD` | Vercel | Yes | Authorized demo user password |

Never prefix a secret with `NEXT_PUBLIC_`.

## 1. Push the repository

Create an empty GitHub repository, then review files before committing:

```powershell
git status
git add .
git diff --cached --check
git commit -m "Prepare MailPilot for cloud deployment"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/mailpilot.git
git push -u origin main
```

If this directory already has an `origin`, inspect it with `git remote -v` instead of replacing it. Do not change visibility or rewrite history as part of deployment preparation.

## 2. Create Railway services

1. In Railway, create a project and add a **PostgreSQL** service. Keep it private. Copy its private `DATABASE_URL` reference for the Go API; do not enable a public database endpoint.
2. Add a GitHub-backed service for the API. Set its root directory to `services/api`; Railway reads `services/api/railway.toml` and its multistage Dockerfile. Set the Go variables from the table above and wait for `/health` to report healthy.
3. Add a second GitHub-backed service with root directory `n8n`. It builds the pinned `n8n:2.48.5` base image defined in `n8n/Dockerfile`.
4. Attach a Railway volume to the n8n service at `/home/node/.n8n`. Configure n8n to use the Railway PostgreSQL service rather than SQLite for durable production state. Keep the n8n PostgreSQL schema separate from MailPilot's application tables, for example with `DB_POSTGRESDB_SCHEMA=n8n` if your Railway configuration supports it.
5. Give the API a public Railway HTTPS domain. Do **not** give n8n a public domain. If temporary editor access is required, use a short-lived protected Railway tunnel or an access-controlled private network, then remove it.

Railway private hostnames are project-specific. In the variables UI, use Railway's service-reference picker for the API, n8n, and PostgreSQL values rather than copying guessed hostnames. `MAILPILOT_API_URL` must resolve privately from n8n, and `N8N_INTAKE_URL` must resolve privately from Go.

The Go API acquires a PostgreSQL advisory lock before applying the two existing idempotent migrations. This prevents concurrent API replicas from racing migrations. Start with one API replica; do not change migration ownership without a separate deployment plan.

## 3. Configure production n8n

Set these additional n8n settings:

```text
N8N_ENCRYPTION_KEY=<fresh stable secret>
N8N_DIAGNOSTICS_ENABLED=false
N8N_PERSONALIZATION_ENABLED=false
N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is required only because the reviewed workflow expressions read the non-secret URL variables and the internal callback token from n8n's environment. Restrict editor and infrastructure access accordingly.

Import `n8n/workflows/01-email-intake.json` through `05-error-monitor.json` using n8n's import UI or CLI while the editor is protected. Then:

1. Create an **HTTP Header Auth** credential with header name `Authorization` and value `Bearer YOUR_OPENROUTER_KEY`.
2. Bind that credential to both OpenRouter HTTP Request nodes in **MailPilot — AI Processing**. Workflow exports contain only a credential reference, never the key.
3. Set the other four workflows' Error Workflow setting to **MailPilot — Error Monitor**.
4. Confirm the Schedule Trigger workflows are active and the Intake webhook path is `/webhook/mailpilot-intake`.
5. Publish all five workflows. Do not import over the existing local n8n instance.

The exported workflows now use `MAILPILOT_API_URL` and `MAILPILOT_INTAKE_URL`, so the same JSON works with local Compose values and Railway private URLs. The original local published workflows are not changed by this repository preparation.

## 4. Deploy the dashboard to Vercel

1. Import the GitHub repository in Vercel.
2. Set **Root Directory** to `apps/web`; Vercel will detect Next.js.
3. Add the Vercel variables in the table. `GO_API_URL` is the public Railway API HTTPS URL, while `GO_API_SHARED_SECRET` matches the Go frontend token.
4. Deploy. The `proxy.ts` guard redirects anonymous dashboard and application-proxy requests to `/login`; `/api/auth/*` stays available for Auth.js.
5. Share the demo email and password privately. There is no signup, password reset, or public API access.

The API proxy adds the Go frontend secret only from server code and applies a 15-second upper timeout for creates. With `N8N_SYNC_PROCESSING=false`, Go persists a queued email, returns `202`, triggers n8n in the background, and the dashboard polls stored status. This avoids relying on a long Vercel request while retaining recovery for n8n outages.

## 5. Verify the deployed demo

Use a fictional email and an authorized browser session:

1. Open the Vercel URL: `/login` must render.
2. Request `/` and `/api/emails` without a session: both must be blocked or redirected.
3. Call the public Railway Go endpoint without `X-MailPilot-Frontend-Token`: it must return `401`; `/health` should remain `200`.
4. Sign in and confirm Inbox loads persisted data.
5. Simulate a fictional email. Observe queued status, then classification, assigned team, draft, and events.
6. Approve or reject a draft and refresh the page to verify persistence.
7. Exercise an SLA candidate and confirm a second scheduled run does not duplicate its notification.
8. Test recovery and Error Monitor only with fictional inputs.

Do not call the n8n editor or webhook publicly. The API's internal endpoints remain inaccessible through the Next.js proxy and require the separate callback token.

## Operations, recovery, and backups

- Railway PostgreSQL backups/restores are performed through Railway's database tooling. Test restore procedures with a separate project before relying on them.
- Back up n8n's persistent volume and export workflows before upgrading n8n. Retain `N8N_ENCRYPTION_KEY`; losing it makes stored credentials unreadable.
- To demonstrate queued recovery, temporarily make the private n8n service unavailable, submit a fictional email, restore n8n, then run or wait for **Queued Email Recovery**. Never stop PostgreSQL or delete volumes for this test.
- Monitor Railway logs for health failures, not request bodies or secrets. The API avoids logging email bodies and the Error Monitor stores a generic error category.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Vercel proxy returns `503 api_not_configured` | Add `GO_API_SHARED_SECRET` and redeploy. |
| Railway Go API exits immediately | Confirm `DATABASE_URL`, `MAILPILOT_INTERNAL_TOKEN`, `N8N_INTAKE_URL`, and in production `MAILPILOT_FRONTEND_TOKEN`. |
| Dashboard gets Go `401` | `GO_API_SHARED_SECRET` and `MAILPILOT_FRONTEND_TOKEN` differ. |
| n8n callback gets `401` | `MAILPILOT_INTERNAL_TOKEN` differs between n8n and Go. |
| n8n cannot call Go | Use a Railway private service reference for `MAILPILOT_API_URL`, not `localhost`. |
| AI calls fail after import | Recreate and bind the OpenRouter Header Auth credential in the Railway n8n instance. |
| Schedule does not run | Verify workflow activation, timezone, n8n persistence, and server time. |
| A create remains queued | Inspect Go/n8n logs and the recovery workflow; do not create a duplicate external message ID. |
