# Frontend

React + Vite app for the interactive repo graph.

## Implemented features

- **Force-directed graph canvas**
- **Search jump-to-node**
- **Repo summary sidebar**
- **Narratives and alerts**
- **Node inspector with insights and neighbors**
- **Backend API integration** for analysis and node detail fetching

## Main files

```
frontend/
├── src/
│   ├── components/
│   ├── lib/api.ts
│   ├── lib/format.ts
│   ├── App.tsx
│   └── styles.css
└── README.md
```

## Run

```bash
npm run dev:frontend
```

The frontend proxies `/api` to `http://localhost:4000` in dev mode.
