# Graph schema (reference)

Canonical node and edge types for the GitHub Repo Knowledge Graph. See IMPLEMENTATION_PLAN.md for full context.

## Node types

| Layer      | Node types                                              | Source                |
|-----------|----------------------------------------------------------|-----------------------|
| Code      | File, Function, Class, Method, Variable, Import, Type   | AST parsing           |
| Structure | Directory, Module, Package                              | FS + manifests        |
| Dependencies | Dependency                                            | Lockfiles + manifests  |
| Git       | Commit, Branch, Tag, BlameRegion                        | Git log + blame       |
| GitHub    | User, Issue, PullRequest, Review, Comment              | GitHub API/GraphQL    |
| Semantic  | Topic, Concept (optional)                               | LLM / keywords        |

## Edge types

- **Code:** `imports`, `calls`, `inherits`, `references`, `defines`, `contains`
- **Structure:** `parent_of`, `depends_on`, `dev_depends_on`
- **Git:** `authored_by`, `changed_in`, `blamed_to`
- **GitHub:** `opened_by`, `assignee`, `fixes`, `references`, `reviewed_by`, `comment_on`
- **Semantic:** `related_to`, `implements`, `similar_to`

## Root

- Single root node per analysis: **Repo** (e.g. `owner/name` + ref). All extractors attach nodes to this repo context.
