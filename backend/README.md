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
- **Serve REST endpoints** for analysis, search, node details, and subgraphs

## API

- `GET /api/health`
- `GET /api/current`
- `POST /api/analyze`
- `GET /api/search?q=...`
- `GET /api/nodes/:nodeId`
- `GET /api/subgraph?nodeId=...&depth=...`

## Runtime notes

- The latest analysis is persisted to the system temp directory.
- Cloned GitHub repos are cached in the same temp cache root.
- The current implementation does not require Neo4j or any external database.
