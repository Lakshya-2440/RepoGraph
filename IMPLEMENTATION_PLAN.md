# The Perfect, Craziest Implementation Plan
## GitHub Repo Knowledge Graph — "Living Map + Mini Agents"

---

## North Star

**One URL. One repo.** A living graph of every important thing in that repo, with moving nodes and mini agents that explain, warn, and suggest as you explore. Feels like the repo is talking to you.

---

## Phase 0: Foundation (Weeks 1–2)

### 0.1 Graph schema ("everything about the repo")

**Node types**

| Layer | Node types | Source |
|-------|------------|--------|
| **Code** | File, Function, Class, Method, Variable, Import, Type | AST parsing (per language) |
| **Structure** | Directory, Module, Package | FS + package manifests |
| **Dependencies** | Dependency (npm/pip/cargo/etc.) | Lockfiles + manifests |
| **Git** | Commit, Branch, Tag, BlameRegion | Git log + blame |
| **GitHub** | User, Issue, PullRequest, Review, Comment | GitHub API + GraphQL |
| **Semantic** | Topic, Concept (optional) | LLM or keyword extraction |

**Edge types**

- **Code:** `imports`, `calls`, `inherits`, `references`, `defines`, `contains`
- **Structure:** `parent_of`, `depends_on`, `dev_depends_on`
- **Git:** `authored_by`, `changed_in`, `blamed_to`
- **GitHub:** `opened_by`, `assignee`, `fixes`, `references`, `reviewed_by`, `comment_on`
- **Semantic:** `related_to`, `implements`, `similar_to`

**Design rule:** If it can be extracted from the repo or GitHub, it gets a node or edge type. No "nice to have" cutoff in the schema—you can add ingestion gradually.

### 0.2 Tech spine

- **Extraction:** Language-specific parsers (Tree-sitter or language ASTs), Git CLI, GitHub API/GraphQL, dependency parsers.
- **Graph store:** Neo4j (Cypher, graph-native) or Neptune. Alternative: Postgres + Apache Age or raw tables with recursive CTEs.
- **Backend:** One service (Node/Python/Go) that: runs extractors, writes graph, exposes GraphQL or REST for "give me subgraph / node / insights."
- **Frontend:** React/Next + a force-directed graph (D3, vis-network, Cytoscape.js, or React Flow with custom physics) so nodes move. WebGL if you go huge (e.g. Sigma.js).
- **Agents:** Small "insight" services: rule-based analyzers (metrics, patterns) + optional LLM micro-service (one short sentence per node/cluster). Cached and attached to node IDs.

---

## Phase 1: Exhaustive extraction (Weeks 3–6)

### 1.1 Pipeline stages

1. **Clone + mirror**  
   Clone repo (or use GitHub API only for metadata). Support branch/tag/commit. Cache.

2. **File tree + manifests**  
   All Directory/File nodes, Package/Module from package.json, Cargo.toml, pyproject.toml, go.mod, etc. Edges: `parent_of`, `depends_on`.

3. **Per-language AST**  
   Per supported language (start with 1–2): parse every file → Function, Class, Method, Variable, Import, Type. Edges: `contains`, `imports`, `calls`, `inherits`, `references`. Use Tree-sitter or language-specific parsers (e.g. tsconfig for TS, ast for Python).

4. **Git history**  
   `git log`, `git blame` → Commit, BlameRegion, User (by email). Edges: `authored_by`, `changed_in`, `blamed_to`. Optional: file-level or hunk-level.

5. **GitHub API**  
   Repo metadata, issues, PRs, reviews, comments, contributors. Nodes: User, Issue, PullRequest, Review, Comment. Edges: `opened_by`, `assignee`, `fixes`, `references`, `reviewed_by`, `comment_on`.

6. **Dependency graph**  
   Resolve versions from lockfiles; create Dependency nodes and `depends_on`/`dev_depends_on` between packages (and optionally link to repo nodes if you track "repo ↔ package").

**Output:** A single graph DB that can answer: "What is in this repo, who changed it, what does it depend on, and what's the discussion?"

### 1.2 Idempotency and incremental

- All extractors keyed by repo + ref (e.g. main or commit SHA).
- Incremental: only re-parse changed files; only fetch new GitHub events; only new commits. So "everything" stays up to date without full rebuilds.

---

## Phase 2: Interactive moving graph (Weeks 7–9)

### 2.1 Layout and motion

- **Force-directed layout:** Nodes repel, edges attract. Use D3-force or vis-network so the graph moves until it stabilizes (or keep a light simulation so it never fully "dies").
- **Optional "breathing":** Very subtle scaling or opacity pulse on nodes so the graph feels alive.
- **Clustering:** Group by directory, package, or "module" (e.g. by label propagation). Draw clusters as hulls or use cluster nodes that you can expand/collapse.

### 2.2 Interaction

- **Zoom and pan:** Infinite canvas.
- **Click node:** Select; side panel shows all attributes (file path, size, last commit, number of callers, linked issues, etc.).
- **Click edge:** Show edge type and optional metadata (e.g. "called 47 times").
- **Search:** By name, path, or "concept." Jump to node and optionally highlight neighborhood.
- **Time slider (optional):** Filter by commit time or "as of date" so the graph can reflect "state of repo at date X."

### 2.3 Performance

- **Level-of-detail:** Don't send 100k nodes to the client. Backend returns subgraphs: "neighborhood of this node," "this directory and 2 levels," "top N by degree." Load more on expand.
- **Spatial indexing:** If you persist layout, store positions and only send visible viewport + buffer.
- **WebGL:** For 10k+ nodes, use Sigma.js or similar so rendering stays smooth.

---

## Phase 3: Mini agents that "tell you something" (Weeks 10–12)

### 3.1 What "mini agents" do

Each agent is a small generator of one insight (text + optional severity/type). It runs in the backend and is attached to a node or a small subgraph. The frontend shows these as:

- **Tooltips** on hover
- **Badges or dots** on nodes (e.g. "entry point," "no tests")
- **Side panel "Insights"** when a node is selected
- **Optional:** Floating "speech bubbles" near nodes that rotate or appear on focus

So the "mini agent" is the logic that produces the insight; the UI is how that insight is shown (bubble, tooltip, panel).

### 3.2 Rule-based agents (fast, deterministic)

Implement many small analyzers; each returns a short string and maybe a type. Examples:

- **Entry point:** "This is the main entry (e.g. index.js / __main__)."
- **Orphan:** "Not imported or referenced anywhere."
- **Hub:** "High fan-out: imported/called by N nodes."
- **Bottleneck:** "Many things depend on this; change with care."
- **Old / stale:** "No changes in X months."
- **Hot:** "Changed in N commits in last 30 days."
- **Large:** "Among the top 5 largest files."
- **No tests:** "No test file found that references this."
- **Controversial:** "Many PR comments or long threads on this file."
- **Ownership:** "Most edits by @user in last 6 months."
- **Dependency risk:** "Depends on a package with known vulnerabilities" (from audit).

Run these in a pipeline per node (or per file); store results in DB or cache keyed by (repo, ref, node_id). Frontend requests "insights for this node" and shows them as agent messages.

### 3.3 LLM micro-agent (one sentence per node/cluster)

- **Input:** Node type, name, path, list of edges (e.g. "imported by X, Y; calls Z"), plus optional rule-based tags.
- **Prompt:** "In one short sentence, tell a developer something useful about this [file/function] in the repo. Be specific and actionable."
- **Output:** One sentence, cached by (repo, ref, node_id, prompt_version).
- **When to run:** On first request for that node, or in a background job after extraction. Rate-limit and queue to control cost.

This gives you the "crazy" feel: the graph doesn't just show structure; it talks ("This is the auth gatekeeper," "Heavy coupling; consider splitting").

### 3.4 Cluster-level agents

For a cluster (directory, module, package):

- "This module has no tests."
- "Owned mostly by team X."
- "Depends on 3 external packages; 1 is deprecated."
- "Entry points: src/index.ts, src/cli.ts."

Same idea: rule-based + optional LLM summary for the cluster.

---

## Phase 4: "One tool that tells you everything" (Weeks 13–14)

### 4.1 Narrative views (guided "tours")

Predefined narratives that walk the graph and surface facts:

- **"How do I run this repo?"** → Entry points, scripts, README, env.
- **"Where is feature X?"** → Search + subgraph + agent insights.
- **"Who knows this part?"** → Blame + GitHub contributors + "most active" agents.
- **"What's risky to change?"** → High coupling, no tests, many dependents, dependency alerts.

Each narrative = a query + a sequence of "focus this node / this cluster" + the corresponding agent insights. So the tool tells you the story, not just shows the graph.

### 4.2 "Explain this" and "Compare"

- **Explain this node:** Return rule-based insights + LLM sentence + list of key edges. Shown in panel or modal.
- **Compare two nodes:** "File A and B both depend on C; A is older and has more callers." Again rule-based + optional LLM.

### 4.3 Home / dashboard for the repo

When you open "this repo" in the tool:

- **Summary card:** Language, size, last activity, top contributors, open issues/PRs.
- **Mini map:** High-level clusters (e.g. packages or top-level dirs) with links into the full graph.
- **Alerts:** "3 dependencies with vulnerabilities," "5 files with no tests," "2 possible dead modules."
- **Link:** "Open full graph" → takes you to the interactive moving graph + agents.

So "every single thing" is available in the graph, but the dashboard tells you the most important things first.

---

## Phase 5: Polish and scale (Weeks 15–16)

- **Multi-repo (optional):** Same schema; Repo as root node; switch repo in UI. Same agents and narratives, keyed by repo.
- **Theming and accessibility:** Dark/light, reduce motion option, keyboard nav, screen reader friendly labels.
- **Export:** Subgraph as JSON or image; shareable link to a view (repo + ref + focused node).
- **Speed:** Precompute hot paths (entry → main modules), cache agent outputs, and keep subgraph queries under ~100–200ms.

---

## Stack summary

| Layer | Suggested tech |
|-------|----------------|
| Extraction | Tree-sitter, language runtimes (tsc, Python ast), Git CLI, GitHub API/GraphQL, lockfile parsers |
| Graph DB | Neo4j or Neptune (or Postgres + Age) |
| Backend | Node (TypeScript) or Python (FastAPI); job queue (BullMQ, Celery) for extraction and LLM |
| Frontend | React, D3/vis-network/Cytoscape/Sigma.js, state (Zustand or React Query) |
| Agents | Rule engine (your code) + optional LLM API (OpenAI/Anthropic) with caching |
| Hosting | Backend + DB + queue on one provider (e.g. Railway, Fly, or AWS); frontend on Vercel/Netlify |

---

## Why this is "perfect" and "craziest"

- **Perfect:** One graph with everything (code, git, GitHub, deps), one UI that moves and explains, and clear phases so you can ship incrementally (e.g. "moving graph + file nodes + 5 agents" first).
- **Craziest:** The repo becomes a character: moving nodes + mini agents that proactively tell you what matters, plus narratives and "explain this" so it feels like the codebase is talking to you.
