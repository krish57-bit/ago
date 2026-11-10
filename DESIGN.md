# Ago: design

One tool (`web_search`). Fast, grounded, and it knows **what you asked and when**.

## Core idea: take time and recall out of the model

"Last Tuesday", "on 3 November", "since Monday" are hard because of calendar maths and recall, not search. So **code resolves dates and retrieves memory before the first model call**; the model gets absolute dates and the relevant past turns as ground truth and spends its effort on searches and evidence. ([LongMemEval](https://arxiv.org/abs/2410.10813): index by timestamp, narrow by time range.)

```
msg ─► resolve dates in user's TZ ─► memory: turns in those windows + BM25      (code, ~20 ms)
    ─► ONE model loop: system = [static prompt | clock + <memory>]
         tool_use×N ─► searches in parallel (cached; ≤4 steps, ≤8 searches; last step can't call tools)
    ─► stream (SSE) ─► guards ─► persist {Q, A, searches, ledger, timings, ts, tz}
```

- **Memory is not a tool.** A tool would cost a model round trip and leave date maths to the model. The `<memory>` block carries absolute timestamps, the earlier answer, its sources and recorded facts. If a date resolves but nothing is stored, it says so ("No stored conversation from 5 November"), so the agent doesn't improvise.
- **"Is it still correct?" runs on a claim ledger adjudicated by code.** The model appends a `<ledger>` JSON block (no extra call): item, was, now, status, source. Code ensures no verdict outruns its evidence: `unchanged`/`changed` need a `now` value present in *this turn's* results; `was` must exist in the memory shown (an invented baseline is dropped); was/now figures are compared in code, so a wrong "unchanged" is corrected; unseen source URLs are removed. The UI shows a **What changed** table with "label corrected by code" notes; the ledger is stored, so the next re-check starts from recorded values.
- **Timezone-correct.** "Monday" = midnight-to-midnight in the user's zone, most recent Monday strictly before today. The UI echoes the resolved date (`"Monday" → Mon 9 Nov 2026`) so a wrong assumption is visible.

## Fast

One loop, no router/planner/critic: latency = one model call (+1 if it searches). Parallel searches; prompt-cached static prefix; 10-min search cache with in-flight dedupe; streaming with thinking/searching/writing states; optional `REASONING_EFFORT=low`; model fallback chain for free-tier quotas. Every run emits a trace (memory ms, first-token, per-search ms) shown in the **Inspector**.

## Right

Prompt contract (verdict first, cite at the claim, dates, primary sources, "no evidence" ≠ "didn't happen"). Recency-aware tool (`since/until`, `topic:news`, `basic→advanced`). Deterministic guards after every answer, no extra model call: **citation guard** (links must come from this turn's results or memory) and **figure guard** (every price/percentage/version must appear in this turn's results; figures only from old memory are labelled "not re-confirmed"). Why: audits such as the Tow Center/CJR study find frequent wrong or fabricated citations, and [STALE](https://arxiv.org/abs/2605.06527) found models catch a stale fact when asked directly (92%) but accept it inside the user's own question (30%). Search output is treated as untrusted data; bad tool args are dropped; failures are surfaced so the agent says what it couldn't check.

**Trust & control:** source side-panel, publisher-named citation chips, a Memory tab listing everything remembered with **Still correct?** and **Forget**, Stop that saves nothing partial, contrast-checked (WCAG AA) light/dark theme.

## Considered and rejected

| Option | Why not |
|---|---|
| Provider-native search | No date filters, no cache, no control over what is stored for later diffs. |
| Memory as a tool / LLM summaries | +latency, model does date maths, summaries lose exact figures. |
| Vector DB / embeddings | A service and latency for one person's chats where dates and keywords carry the signal. |
| SQLite | Native build can break `npm install`; JSONL behind one class. |
| Planner / multi-agent / LangChain | Multiplies latency; a ~150-line loop with injected LLM + search is testable offline. |
| Second model call to extract claims | +latency and quota; one block in the same call, verified by code, does the job. |
| Third-party design-skill pack | Runs third-party code, React/Tailwind-oriented; I wrote the tokens myself. |

## Verification

`npm run check`: 40 offline tests (date resolution incl. TZ edges, retrieval, empty-day honesty, loop with scripted model, OpenAI-compat streaming + Gemini quirks, citation/figure guards, ledger adjudication, model fallback, HTTP hardening). `npm run eval`: live deterministic checks on the example shapes (behaviour, grounding, latency). The model sits behind one `LLM` interface (Anthropic or any OpenAI-compatible API); the prompt is written for Claude and tool-calling quality varies by model.

## With another week

1. **Supersession across turns:** newest value wins, older shown as "previously"; per-item history.
2. **Watches:** persist a claim and re-check on a schedule (the proactive half; no major assistant diffs a *specific past answer*).
3. **Hybrid retrieval** (embeddings + BM25) and LLM-judge evals on a larger set.
4. **Speculative search** from the raw question while the model decides.
5. **Page extraction inside `web_search`** to confirm exact prices on the vendor page.
