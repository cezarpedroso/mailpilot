# MailPilot web

The Next.js dashboard for the existing Go, PostgreSQL, n8n, and OpenRouter stack. See the repository root `README.md` for architecture and full setup.

```sh
docker compose up -d --build # from repository root
cd apps/web
npm install
npm run dev
```

Open `http://localhost:3000`. Copy `.env.example` to `.env.local` only if the Go API is not at the default `http://127.0.0.1:8080`.

Checks: `npx tsc --noEmit`, `npm run lint`, `npm run build`.
