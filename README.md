# Ago

**Search that remembers when.** Ago is a chat assistant with exactly one tool, web search, and a dated memory of everything you've asked. It answers fast, cites what it found, and can tell you what you asked on any day and whether the answer still holds.

> "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
>
> Ago resolves *last Tuesday* to an exact date in your timezone, recalls that conversation, re-checks each provider against live sources, and returns a table of what changed, what didn't, and what it couldn't verify, with every verdict checked by code.

Architecture, trade-offs and what was rejected: [DESIGN.md](DESIGN.md).

## What makes it different

| | |
|---|---|
| **Dates are resolved in code** | "Monday", "3 November", "last week" become exact windows in your timezone *before* the model runs. The UI shows what each phrase resolved to. |
| **Dated, inspectable memory** | Every exchange is stored with its time, sources and the facts it asserted. Browse it by day, re-verify any answer (**Still correct?**), or **Forget** it. Export everything as JSON. |
| **Verdicts can't outrun evidence** | A claim ledger records each checkable fact. Code downgrades "unchanged" unless this turn's sources confirm the value, corrects labels when numbers differ, and drops invented baselines and links. |
| **Grounding guards** | Links and figures in an answer must come from this turn's search results; anything else is flagged. |
| **Shows its work** | Per-answer inspector (memory lookup, model steps, parallel searches with timings) and a side panel of sources with publication dates. |
| **Fast** | One model loop, parallel searches, cached prompt prefix, streaming. No router, planner or critic. |

## Quick start

Requires Node 20.6+.

```bash
npm install
cp .env.example .env      # add a model key and a Tavily key
npm run dev               # http://localhost:3000
```

Keys (see [`.env.example`](.env.example)):

- **Model**: `ANTHROPIC_API_KEY`, *or* any OpenAI-compatible API (Google Gemini's free tier works: set `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_BASE_URL`, `MODEL`).
- **Search**: `TAVILY_API_KEY` (free tier is enough).

First time? Click **Add sample history** on the start screen to load three past chats dated relative to today, then ask:

- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*
- *What did I ask you on 3 November? Is your answer still correct today?*

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Anthropic model (default provider). |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` | `anthropic` | OpenAI-compatible provider instead (Gemini, Groq, OpenRouter, Ollama…). |
| `MODEL` | `claude-sonnet-5-5` | Model id. Comma-separate for a **fallback chain** (useful on free tiers with per-model daily quotas). |
| `REASONING_EFFORT` | unset | `low` makes Gemini much faster. Leave unset for providers that reject it. |
| `TAVILY_API_KEY` | | Search backend. `SEARCH_PROVIDER=mock` runs without it. |
| `PORT`, `DEFAULT_TIMEZONE`, `DATA_DIR` | `3000`, system, `data` | Server basics; the browser's timezone is used when available. |
| `RATE_LIMIT_PER_MIN` | `20` | Chat requests per client per minute (`0` disables). |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `pretty` | `silent` mutes; `json` for structured logs. |

## Development

```bash
npm run check     # typecheck + 40 offline tests (no API keys needed)
npm test          # tests only
npm run eval      # live eval: example question shapes, deterministic checks, latency
```

`npm run eval -- crm` runs one case. Evals use real keys and the free-tier quota; checks are deterministic (behaviour, grounding, latency), not LLM-judged.

```
src/
  agent/    loop (agent.ts), prompt + tool schema (prompt.ts), model adapters (llm.ts)
  memory/   temporal.ts (date resolution), retrieve.ts (date windows + BM25), store.ts (JSONL)
  search/   Tavily provider, TTL cache, mock
  ledger.ts claim ledger and its code-side adjudication
  sources.ts  citation universe, citation guard, figure guard
  app.ts    HTTP app factory (security headers, rate limit, API)   server.ts  process entrypoint
  public/   index.html, app.css, app.js (no build step, no inline scripts)
test/       offline tests with scripted model and search
```

### API

| | |
|---|---|
| `POST /api/chat` | `{message, conversationId?, tz?}` → Server-Sent Events: `memory`, `status`, `text`, `reset`, `tool`, `step`, `sources`, `ledger`, `done`, `error` |
| `GET /api/history?conversationId=` | Turns of a conversation, with sources and ledger |
| `GET /api/memory`, `GET /api/export` | Everything remembered (list / JSON download) |
| `GET /api/conversations`, `DELETE /api/conversations/:id`, `DELETE /api/turns/:id` | Manage what is remembered |
| `POST /api/sample`, `POST /api/seed` | Load sample history / import turns with explicit timestamps |
| `GET /api/health` | Version, model, configuration problems |

`ALLOW_CLOCK_OVERRIDE=1` lets a client send `{"now": "<ISO>"}` to `/api/chat` to simulate a different "today" (used for evals).

## Data and security

- **Everything stays local.** Memory is an append-only JSONL file at `data/memory.jsonl` (git-ignored). Ago sends your questions to your chosen model and search providers, and nothing else anywhere.
- You can see, export and delete everything from the UI; there is no hidden profile.
- The server sends a strict Content-Security-Policy (no inline scripts), rejects cross-origin writes, limits request size, and rate-limits chat. Search results are treated as untrusted data by the prompt.
- It is built as a single-user local app: there is no authentication, so don't expose it to the internet as is.

## Troubleshooting

- **`Port 3000 is already in use`**: another copy is running. Stop it or use `PORT=3001 npm run dev`.
- **`429` / "quota exceeded" from Gemini**: free keys have a small per-model daily limit. Add fallback models to `MODEL`, e.g. `MODEL=gemini-3.5-flash,gemini-flash-lite-latest`.
- **401 from Anthropic**: the key must start with `sk-ant-`; check the account has credit.
- **Banner says a key is missing**: edit `.env`, then restart (`.env` is read at startup).

## License

[MIT](LICENSE)
