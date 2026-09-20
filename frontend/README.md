# StudyFlow frontend

React (Vite) single-page app. See the [root README](../README.md) for full setup.

```bash
npm install
npm run dev      # http://localhost:5173 — proxies /api/* to the backend on :5000
npm run build    # static bundle in dist/
npm run lint
```

- API base URL: `/api` by default (dev proxy). For a production build against a separately hosted API, set `VITE_API_URL` at build time.
- Routing is hash-based (`#/`, `#/new`, `#/plan/:id`), so it works on any static host without rewrite rules.
