# RepoGraph: GitHub Repository Knowledge Graph

RepoGraph converts a local repository path or GitHub repository URL into an explorable knowledge graph with code structure, dependency links, git history, GitHub metadata, deterministic insights, and AI-assisted analysis.

The application is full-stack:

- Backend API and analyzer (TypeScript + Express)
- Frontend explorer (React + Vite)
- Shared contracts used by both layers
- Postgres persistence for users, analyses, and AI events

## Core capabilities

- Analyze a local repo path or GitHub URL (+ optional ref)
- Build a graph of nodes and edges for:
	- Repository structure (Repo, Directory, File)
	- Code symbols (Function, Class, Method, Variable, Type, Import)
	- Package/dependency metadata
	- Git commits/authors/file activity
	- GitHub issues, pull requests, users, comments (for GitHub sources)
- Generate deterministic repository insights:
	- Entry point, No tests, Orphan, Hub, Bottleneck, Hot file, Ownership, Stale, Large file
- Explore data through multiple UI surfaces:
	- Force graph canvas
	- File explorer with source preview
	- Dependency tree
	- Contributor view
	- Stats dashboard
	- Insight explorer
	- Floating repo chat assistant
- Run AI features:
	- Context-aware repository Q&A
	- AI insight generation
	- AI code-origin estimate

## Architecture overview

### Frontend

- React app in `frontend/src`
- Uses `@shared` types for request/response contracts
- Talks to backend via `/api` (proxy in local dev) or `VITE_API_BASE` in hosted environments
- Key UI modules include graph visualization, command palette, chat, insights, dependencies, contributors, and file browser

### Backend

- Express API in `backend/src/index.ts`
- Analyzer in `backend/src/analyzer/analyzeRepository.ts`
- Auth and JWT middleware in `backend/src/auth.ts`
- Postgres initialization and access in `backend/src/db/index.ts`
- Per-user analysis cache/store in `backend/src/store/analysisStore.ts`
- AI endpoints in `backend/src/chat/*`

### Shared contracts

- Cross-layer graph, summary, auth, and API types in `shared/src/types.ts`

## Tech stack

- Runtime: Node.js (ESM)
- Language: TypeScript
- Backend: Express, cors, pg, jsonwebtoken, bcryptjs
- Parsing and extraction: `@babel/parser`, `@babel/traverse`
- Frontend: React 18, Vite, `react-force-graph-2d`
- Auth identity options: Email/password, Google Identity Services
- AI provider (active): OpenRouter Chat Completions API
- Infra: Render deployment config (`render.yaml`) and Vercel static frontend config (`vercel.json`)

## Repository layout

```text
backend/
	src/
		analyzer/
		chat/
		config/
		db/
		logging/
		store/
		auth.ts
		index.ts
frontend/
	src/
		components/
		lib/
		App.tsx
shared/
	src/
docs/
	SCHEMA.md
README.md
package.json
```

## API surface

All non-authenticated endpoints validate input and return JSON errors on failure.
Most application endpoints require `Authorization: Bearer <token>`.

### Health and session

- `GET /api/ready`
	- Liveness/readiness and AI key/model visibility
- `GET /api/health` (auth required)
	- Returns status + whether the user has a stored analysis and whether one is running
- `GET /api/auth/me` (auth required)
	- Returns authenticated user identity

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/google`
- `POST /api/auth/request-email-verification`
- `POST /api/auth/verify-email`
- `POST /api/auth/request-password-reset`
- `POST /api/auth/reset-password`

### Analysis and graph

- `GET /api/current` (auth required)
	- Current analysis for the signed-in user
- `POST /api/analyze` (auth required)
	- Triggers a new analysis using `{ source, ref? }`
- `GET /api/search?q=...` (auth required)
	- Search graph nodes
- `GET /api/nodes/:nodeId` (auth required)
	- Node detail + inbound/outbound + neighbors + deterministic insights
- `GET /api/file-content?path=...` (auth required)
	- Returns file content (capped/truncated) + inferred language
- `GET /api/subgraph?nodeId=...&depth=...&limit=...` (auth required)

### AI endpoints

- `POST /api/chat` (auth required)
	- Repository Q&A with RAG-style context retrieval
- `POST /api/insights/ai` (auth required)
	- LLM-generated engineering insights from graph summary/context
- `POST /api/ai/code-origin` (auth required)
	- LLM estimate of AI-assisted code percentage

## Data model (database)

Initialized automatically on startup:

- `users`
- `analysis_runs`
- `ai_events`
- `auth_tokens`
- `auth_login_attempts`

Important behavior:

- Analyses are stored per user in `analysis_runs`.
- The app keeps an in-memory current-analysis cache per user for faster reads.
- AI events are persisted for audit/history visibility.

## Environment variables

Create local env files from templates:

- Root backend env: `.env.example` -> `.env`
- Frontend env: `frontend/.env.example` -> `frontend/.env`

### Required backend env (production)

- `DATABASE_URL`
- `JWT_SECRET` (minimum 32 chars in production)
- `CORS_ORIGIN`
- `APP_BASE_URL` (must be `https://` in production)

### Common backend env

- `PG_SSL_STRICT`
- `JWT_EXPIRES_IN`
- `JWT_ISSUER` (optional, default `repograph-auth`)
- `JWT_AUDIENCE` (optional, default `repograph-client`)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_IDS`
- `GOOGLE_AUTH_STRICT_AUDIENCE`
- `GITHUB_TOKEN` (optional, improves GitHub API limits)
- `OPENROUTER_API_KEY` (required for AI features)
- `OPENROUTER_MODEL` (optional, default `minimax/minimax-m2.5:free`)
- `CORS_ORIGIN_EXTRA`
- `ALLOW_VERCEL_PREVIEW_ORIGINS`
- `PORT` (defaults to `4000`)

### Security/rate-limit tuning env (optional)

- `TRAFFIC_ALERT_THRESHOLD`
- `AUTH_FAILURE_ALERT_THRESHOLD`
- `API_RATE_LIMIT_MAX_REQUESTS`
- `ENUMERATION_ALERT_THRESHOLD`

### Frontend env

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs backend (watch mode) and frontend dev server together |
| `npm run dev:backend` | Runs backend only (`tsx watch`) |
| `npm run dev:frontend` | Runs frontend only (Vite) |
| `npm run build` | Builds backend and frontend |
| `npm run build:backend` | Builds backend bundle into `backend/dist` |
| `npm run build:frontend` | Builds frontend assets into `frontend/dist` |
| `npm run start` | Starts production backend (`backend/dist/index.js`) |
| `npm run typecheck` | Typechecks backend + frontend TS projects |

- `VITE_API_BASE`
	- Required in hosted deployments
	- Usually not required in local dev because Vite proxies `/api` to `http://localhost:4000`
- `VITE_GOOGLE_CLIENT_ID`

## Local development

### Prerequisites

- Node.js 20+
- npm 10+
- PostgreSQL-compatible connection string (Neon recommended)

### Install

```bash
npm install
```

### Configure env

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

Fill values in both files before starting.

### Run full stack (backend + frontend)

```bash
npm run dev
```

Local URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

### Typecheck

```bash
npm run typecheck
```

### Production build and run

```bash
npm run build
npm run start
```

## Typical user flow

1. Sign up or sign in (email/password or Google)
2. Provide a local absolute path or GitHub repo URL
3. Run analysis
4. Explore graph, dependencies, contributors, stats, and insights
5. Ask repository questions via chat

## Deployment notes

### Render (`render.yaml`)

- Web service builds backend and starts API server
- Health check endpoint: `/api/ready`
- Managed Postgres resource is provisioned and connected via `DATABASE_URL`

### Vercel (`vercel.json`)

- Frontend static build output: `frontend/dist`
- SPA rewrite to `index.html`

When deploying frontend and backend separately:

- Set `VITE_API_BASE` on frontend to backend public URL
- Set backend CORS origins to include frontend domain(s)

## Security behavior

- Strict security headers are set for responses
- HTTPS is enforced in production
- CORS allow-list checks include optional explicit extras and optional Vercel preview origins
- API-wide rate limits plus endpoint-specific rate limits for auth, analysis, reads, and AI routes
- Structured security event logging for:
	- traffic spikes
	- auth failure spikes
	- API enumeration spikes
	- auth guard failures and API errors

Note: verification/reset token dispatch currently logs an email event fingerprint and path placeholder. Integrate a real email provider (SES/SendGrid/etc.) for production delivery.

## Current limitations

- Symbol extraction is focused on JS/TS-family parsing
- File-content endpoint truncates large file responses
- Git insights are partial when source has no accessible git history
- AI features require a valid OpenRouter key

## Reference docs

- Graph schema reference: `docs/SCHEMA.md`
- Shared contract summary: `shared/README.md`

## License

MIT
