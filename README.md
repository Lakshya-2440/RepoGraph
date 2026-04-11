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
- **Storage:** In-memory graph with the latest analysis persisted to the system temp directory
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

## Usage

1. Enter an absolute local path or a GitHub URL like `https://github.com/chalk/chalk`.
2. Click `Analyze`.
3. Explore the graph, search for nodes, and inspect narratives and insights.

## Notes

- The latest analysis and cloned GitHub repos are cached under your system temp directory in `github-knowledge-graph-cache`.
- Git history only appears when the analyzed source is a git repo.
- GitHub issues, PRs, comments, and repo stats are fetched for GitHub URLs.
- The current extractor focuses on JS/TS AST analysis. Other file types still appear as structural nodes.

## License

MIT (or your choice).
