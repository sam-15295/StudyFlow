# StudyFlow

StudyFlow is a multi-agent study planner. A student pastes syllabus text and sets an
exam date and daily study hours. A pipeline of narrowly scoped LLM agents extracts the
topics and estimates each one's difficulty and hours. A deterministic scheduler then
builds a day-by-day plan. If the student falls behind, the remaining topics are
replanned, with a one-line explanation of what changed.

Stack: Node.js + Express, MongoDB, JWT cookie auth, OpenRouter (single free model), React (Vite).

## How it works

```
Syllabus text ──► Topic Extractor (LLM) ──► Difficulty Estimator (LLM) ──► Scheduler (plain code) ──► day-by-day plan
                                                                                    ▲
                     mark a topic done / missed ──► Replan (scheduler again) ──► Replan Explainer (LLM, one sentence)
```

- **Topic Extractor** – one LLM call: raw syllabus → clean list of topics.
- **Difficulty Estimator** – one batched LLM call: each topic → difficulty 1–5 and estimated hours.
- **Scheduler** – deterministic, no LLM: hardest topics first, fills each day up to your daily hours, splits topics longer than a day, and warns (instead of silently dropping topics) if there isn't enough time.
- **Replan** – when a topic is marked missed, or done more than a day off its scheduled date, the remaining topics are re-spread over the remaining days, and an LLM writes a one-sentence explanation (with a plain-text fallback if the model is unavailable).

All LLM calls use one OpenRouter model (set with `LLM_MODEL`), ask for strict JSON, parse defensively (fences/prose tolerated, shape validated) and retry once on a bad reply.

## Prerequisites

- Node.js (developed on v25; an LTS version such as 22 should also work)
- A local MongoDB running on the default port (`mongodb://localhost:27017`)
- A free [OpenRouter](https://openrouter.ai) API key

## Setup

```bash
git clone https://github.com/sam-15295/StudyFlow.git
cd StudyFlow
```

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # then fill in the values below
npm run dev               # http://localhost:5000  (npm start for a plain run)
```

Edit `backend/.env`:

| Variable | Value |
|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/StudyFlow` |
| `JWT_SECRET` | any long random string (used to sign login cookies) |
| `OPENROUTER_API_KEY` | your OpenRouter API key |
| `LLM_MODEL` | a model id ending in `:free` from [openrouter.ai/models](https://openrouter.ai/models), e.g. `nvidia/nemotron-3-super-120b-a12b:free` (free models change — pick a current one) |
| `PORT` | `5000` |
| `CLIENT_ORIGIN` | optional; defaults to `http://localhost:5173` |
| `NODE_ENV` | leave empty for local development |

Check it: `curl http://localhost:5000/health` → `{"status":"ok"}`, and the server log shows `MongoDB connected: StudyFlow`.

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

The dev server proxies `/api/*` to the backend on port 5000, so no CORS or cookie setup is needed locally. (If port 5000 or 5173 is already used by another app, change `PORT` in `backend/.env` and the proxy `target` in `frontend/vite.config.js` to match.) Open http://localhost:5173, sign up, create a plan and press **Build my plan**.

## Tests

```bash
cd backend
npm test
```

Runs with Node's built-in test runner against a separate throwaway database (`StudyFlow_test`) and a mocked LLM — no API quota is used. Requires the local MongoDB. Frontend: `npm run lint` and `npm run build` in `frontend/`.

## API overview

| Route | Purpose |
|---|---|
| `POST /auth/signup`, `/auth/login`, `/auth/logout`, `GET /auth/me` | cookie-based auth |
| `GET/POST /plans`, `GET/DELETE /plans/:id` | plans (own plans only) |
| `POST /plans/:id/extract` | Topic Extractor Agent |
| `POST /plans/:id/estimate` | Difficulty Estimator Agent |
| `POST /plans/:id/generate` | deterministic scheduler |
| `PATCH /plans/:id/topics/:topicId/status` | mark `pending` / `done` / `missed` (may replan) |

## Notes

- Free OpenRouter models are rate limited (accounts without credits get a small daily request cap) and can be slow. The app retries once, shows clear messages, and keeps working with a plain-text replan explanation if the model is unavailable.
- Dates are handled as UTC calendar days.
