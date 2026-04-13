# GitHub Repo Knowledge Graph

**One URL. One repo.** A living graph of the repo with node-level insights, search, and a force-directed UI.

## What this is

- **Repository analyzer:** Works on a local path or a GitHub repo URL.
- **Graph extraction:** Files, directories, packages, dependencies, JS/TS symbols, git history, and public GitHub metadata become nodes and edges.
- **Interactive UI:** Force-directed graph, search, narratives, summary cards, and node inspector.
- **Mini agents:** Rule-based insights such as `Entry point`, `No tests`, `Hub`, `Bottleneck`, `Hot file`, `Ownership`, and `Orphan`.

## Implemented stack

- **Backend:** Node.js + Express + Babel parser/traverse
- **Frontend:** React + Vite + `react-force-graph-2d`
- **Auth:** JWT auth with email/password login
- **Storage:** Neon Postgres via `pg` (`users`, `analysis_runs`, `ai_events`)
- **GitHub API:** Optional `GITHUB_TOKEN` for better rate limits

## Docs

- **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** — Original phased vision
- **[docs/SCHEMA.md](./docs/SCHEMA.md)** — Node and edge reference

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

Production build:

```bash
npm run build
npm run start
```

Open `http://localhost:4000`.

## Environment

Set these variables in `.env` (for local) or Render service environment settings:

```bash
DATABASE_URL=postgresql://...
PG_SSL_STRICT=false
JWT_SECRET=replace-with-a-long-random-secret
JWT_EXPIRES_IN=12h
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_IDS=optional,comma-separated,ids
GOOGLE_AUTH_STRICT_AUDIENCE=false
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id
HF_TOKEN=hf_xxx
GITHUB_TOKEN=optional
CORS_ORIGIN_EXTRA=optional,comma-separated,origins
ALLOW_VERCEL_PREVIEW_ORIGINS=false
PORT=4000
TRAFFIC_ALERT_THRESHOLD=300
AUTH_FAILURE_ALERT_THRESHOLD=20
```

Security rules for secrets:

1. Never commit real credentials. Keep local secrets only in ignored files (`.env`, `.env.local`, `.env.*`).
2. Server-only secrets (`DATABASE_URL`, `JWT_SECRET`, `HF_TOKEN`, `GITHUB_TOKEN`) must never appear in frontend code or `VITE_` variables.
3. Only expose public client settings through `VITE_` variables.
4. Use `.env.example` and `frontend/.env.example` as templates and keep real values in deployment secret managers.

Neon + Render production notes:

1. Create a Neon project and copy its direct (non-pooled) `DATABASE_URL`.
2. Set the backend service env vars on Render (`DATABASE_URL`, `JWT_SECRET`, `HF_TOKEN`, optional `GITHUB_TOKEN`).
2.1 If frontend and backend use different Google OAuth client IDs across environments, set `GOOGLE_CLIENT_IDS` on backend to include every allowed web client ID.
3. Keep `JWT_SECRET` unique per environment and rotate periodically.
4. Use HTTPS-only frontend URL in production for secure auth token transport.

## Secure deployment checklist

1. Enforce HTTPS end to end:
	- Set `APP_BASE_URL` to an `https://` URL.
	- Backend rejects non-HTTPS API traffic in production.
2. Store secrets only in deployment secret managers (Render/Vercel env settings), never in frontend code or committed files.
3. Restrict database exposure:
	- Use private service-to-database networking or a managed database endpoint that is only reachable from the backend.
	- Keep the database connection string in backend-only secrets and require TLS on the connection.
	- Do not expose database ports publicly or embed DB credentials in frontend apps.
4. Monitor suspicious behavior:
	- Backend emits structured `security` logs for auth attempts, API errors, traffic spikes, and auth-failure spikes.
	- Tune `TRAFFIC_ALERT_THRESHOLD` and `AUTH_FAILURE_ALERT_THRESHOLD` for your traffic profile.

## Usage

1. Enter an absolute local path or a GitHub URL like `https://github.com/chalk/chalk`.
2. Click `Analyze`.
3. Explore the graph, search for nodes, and inspect narratives and insights.

## Notes

- Each authenticated user gets isolated analyses and AI event history in Postgres.
- Cloned GitHub repos are cached under your system temp directory in `github-knowledge-graph-cache`.
- Git history only appears when the analyzed source is a git repo.
- GitHub issues, PRs, comments, and repo stats are fetched for GitHub URLs.
- The current extractor focuses on JS/TS AST analysis. Other file types still appear as structural nodes.

## License

MIT (or your choice).
