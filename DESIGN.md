# Ago: design

One tool (`web_search`). Fast, grounded, and it knows **what you asked and when**.

## Core idea: take time and recall out of the model

"Last Tuesday" and "since Monday" are hard because of calendar maths and recall, not search. So **code resolves dates and retrieves memory before the first model call**. The model receives absolute dates and the relevant past turns as ground truth, and spends its effort on searches and evidence. ([LongMemEval](https://arxiv.org/abs/2410.10813) found the same recipe works: index by timestamp, narrow by time range.)

```
msg ─► resolve dates in user's TZ ─► memory: turns in those windows + BM25     (code, ~20 ms)
    ─► ONE model loop: tool_use×N ─► parallel, cached searches (≤4 steps, ≤8 searches)
    ─► stream ─► guards ─► persist {Q, A, sources, ledger, timings, ts, tz}
```

- **Memory is not a tool.** A tool costs a model round trip and leaves date maths to the model. The injected `<memory>` block carries absolute timestamps, the earlier answer, its sources and recorded facts. If a date resolves but nothing is stored, it says so, so the agent doesn't improvise.
- **"Is it still correct?" runs on a claim ledger checked by code.** The model appends a small `<ledger>` block in the same call (no extra request). Code ensures no verdict outruns its evidence: "unchanged" or "changed" needs a current value present in *this turn's* search results; an earlier value must exist in memory (an invented baseline is dropped); figures are compared in code, so a wrong label is corrected; unseen source URLs are removed. The UI shows a **What changed** table, and the ledger is stored for the next re-check.
- **Timezone-correct.** "Monday" is midnight-to-midnight in the user's zone, and the UI shows the resolved date so a wrong assumption is visible.

## Fast

One loop, no router, planner or critic: latency is one model call, plus one if it searches. Searches run in parallel, the static prompt is cached, results are cached for 10 minutes, and tokens stream immediately. Every run emits a trace (memory ms, first token, per-search ms) shown in the Inspector.

## Right

Two deterministic guards run after every answer, with no extra model call: a **citation guard** (links must come from this turn's results or memory) and a **figure guard** (every price, percentage or version must appear in this turn's results; figures only from old memory are labelled "not re-confirmed"). Why: audits like the Tow Center/CJR study find frequent wrong or fabricated citations, and [STALE](https://arxiv.org/abs/2605.06527) found models catch a stale fact when asked directly (92%) but accept it inside the user's own question (30%). Search output is treated as untrusted data, and failures are surfaced so the agent says what it couldn't check.

## Considered and rejected

| Option | Why not |
|---|---|
| Provider-native search | No date filters, no cache, no control over what is stored for later diffs. |
| Memory as a tool, or LLM summaries | More latency; the model does the date maths; summaries lose exact figures. |
| Vector DB / embeddings | A service and latency for one person's chats, where dates and keywords carry the signal. |
| Planner, multi-agent, LangChain | Multiplies latency; a ~150-line loop with injected model and search is testable offline. |
| Second call to extract claims | Extra latency and quota; one block in the same call, verified by code, does the job. |

## Verification

`npm run check`: 40 offline tests (date resolution, retrieval, empty-day honesty, the loop with a scripted model, streaming adapters, both guards, ledger adjudication, HTTP hardening). `npm run eval`: live, deterministic checks on the example question shapes. The model sits behind one `LLM` interface (Anthropic or any OpenAI-compatible API); the prompt is written for Claude, and tool-calling quality varies by model.

## With another week

1. **Supersession across turns:** newest value wins, older shown as "previously".
2. **Watches:** re-check a stored claim on a schedule, the proactive half of this product.
3. **Hybrid retrieval** (embeddings plus BM25) and LLM-judge evals on a larger set.
4. **Speculative search** from the raw question while the model decides.
