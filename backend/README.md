# Backend

Express API and extraction pipeline for the GitHub Repo Knowledge Graph.

## Implemented responsibilities

- **Extract local paths or GitHub URLs**
- **Walk file trees** into `Repo`, `Directory`, and `File` nodes
- **Parse `package.json`** into `Package` and `Dependency` nodes
- **Parse JS/TS ASTs** into `Function`, `Class`, `Method`, `Variable`, `Import`, and `Type` nodes
- **Read git history** into `Commit`, `User`, and `changed_in` relationships when available
- **Fetch GitHub metadata** into `Issue`, `PullRequest`, `Comment`, and `User` nodes for GitHub sources
- **Generate rule-based insights**
- **Serve REST endpoints** for auth, analysis, search, node details, AI chat, and AI insights

## API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/google`
- `POST /api/auth/request-email-verification`
- `POST /api/auth/verify-email`
- `POST /api/auth/request-password-reset`
- `POST /api/auth/reset-password`
- `GET /api/auth/me`
- `GET /api/ready`
- `GET /api/health`
- `GET /api/current`
- `POST /api/analyze`
- `GET /api/search?q=...`
- `GET /api/nodes/:nodeId`
- `GET /api/subgraph?nodeId=...&depth=...`
- `POST /api/chat`
- `POST /api/insights/ai`
- `POST /api/ai/code-origin`

## Runtime notes

- Protected endpoints require `Authorization: Bearer <token>`; auth bootstrap endpoints are public.
- `/api/ready` is public for platform health checks; `/api/health` is authenticated and user-scoped.
- Email/password login requires verified email, sessions expire via JWT (`JWT_EXPIRES_IN`, default `12h`), and login attempts are rate-limited per IP+email.
- Auth tokens for verification and password reset are hashed in storage and expire automatically.
- Security logs are emitted for auth attempts, API server errors, and traffic anomaly spikes.
- In production, `APP_BASE_URL` and `CORS_ORIGIN` must use `https://`, and database connections should stay backend-only with TLS enabled.
- Analysis and AI usage are persisted in Postgres tables (`users`, `analysis_runs`, `ai_events`).
- Cloned GitHub repos are cached in the same temp cache root.
- Required env vars: `DATABASE_URL`, `JWT_SECRET`, `HF_TOKEN`, `GOOGLE_CLIENT_ID`.
