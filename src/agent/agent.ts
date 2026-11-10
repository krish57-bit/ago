import { randomUUID } from 'node:crypto';
import { adjudicate, parseLedger } from '../ledger.js';
import { retrieveMemory } from '../memory/retrieve.js';
import type { MemoryStore } from '../memory/store.js';
import { checkFigures, collectSources, unverifiedLinks, type FigureCheck, type Source } from '../sources.js';
import type { LedgerItem, SearchParams, SearchProvider, SearchRecord, SearchResult, TurnRecord } from '../types.js';
import type { Block, LLM, Msg } from './llm.js';
import { SYSTEM_PROMPT, WEB_SEARCH_TOOL, dynamicContext } from './prompt.js';

export interface AgentDeps {
  llm: LLM;
  search: SearchProvider;
  store: MemoryStore;
  maxSteps?: number;
  maxSearches?: number;
}

/** Everything the UI (and evals) can observe about a run. The trace is a by-product of the loop, not extra work. */
export type AgentEvent =
  | { type: 'memory'; ms: number; windows: { text: string; label: string }[]; recalled: { id: string; ts: string; user: string }[] }
  | { type: 'status'; text: string }
  | { type: 'text'; delta: string }
  /** The text streamed so far belonged to a step that ended in tool calls; clear it. */
  | { type: 'reset' }
  | { type: 'tool'; query: string; since?: string; ms: number; results: number; error?: string }
  | { type: 'step'; n: number; ms: number; ttftMs?: number; toolCalls: number }
  | { type: 'sources'; sources: Source[] }
  | { type: 'ledger'; items: LedgerItem[] }
  | { type: 'done'; turnId: string; searches: number; steps: number; ms: number; ttftMs?: number; unverified: string[]; figures: FigureCheck };

export interface TurnInput {
  conversationId: string;
  text: string;
  tz: string;
  now: Date;
  signal?: AbortSignal;
}

const HISTORY_TURNS = 12;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function formatResults(rawQuery: string, results: SearchResult[]): string {
  const query = rawQuery.replace(/["<>]/g, "'");
  if (results.length === 0) return `<search_results query="${query}">No results.</search_results>`;
  const body = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\nPublished: ${r.publishedDate ?? 'date not shown'}\n${r.snippet}`)
    .join('\n\n');
  return `<search_results query="${query}">\n${body}\n</search_results>`;
}

function parseParams(input: Record<string, unknown>): SearchParams | string {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) return 'query is required';
  const p: SearchParams = { query: query.slice(0, 400) };
  if (input.topic === 'news' || input.topic === 'general') p.topic = input.topic;
  if (input.depth === 'basic' || input.depth === 'advanced') p.depth = input.depth;
  // Bad dates are dropped, not fatal: a wrong filter should not cost the user a search.
  if (typeof input.since === 'string' && ISO_DAY.test(input.since)) p.since = input.since;
  if (typeof input.until === 'string' && ISO_DAY.test(input.until)) p.until = input.until;
  return p;
}

export async function runTurn(deps: AgentDeps, input: TurnInput, emit: (e: AgentEvent) => void): Promise<TurnRecord> {
  const started = Date.now();
  const maxSteps = deps.maxSteps ?? 4;
  const maxSearches = deps.maxSearches ?? 8;
  const { conversationId, text, tz, now, signal } = input;

  // 1. Memory is resolved by code, before the first model call.
  const tMem = Date.now();
  const memory = retrieveMemory(deps.store, { query: text, now, tz, excludeConversationId: conversationId });
  emit({
    type: 'memory',
    ms: Date.now() - tMem,
    windows: memory.windows.map((w) => ({ text: w.text, label: w.label })),
    recalled: memory.turns.map((t) => ({ id: t.id, ts: t.ts, user: t.user })),
  });

  // 2. Live conversation = final texts of previous turns (search internals live in the store, not the prompt).
  const messages: Msg[] = [];
  for (const t of deps.store.conversation(conversationId).slice(-HISTORY_TURNS)) {
    messages.push({ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant });
  }
  messages.push({ role: 'user', content: text });

  const system = [{ text: SYSTEM_PROMPT, cache: true }, { text: dynamicContext(now, tz, memory.block) }];
  const searches: SearchRecord[] = [];
  let answer = '';
  let searchCount = 0;
  let steps = 0;
  let firstTokenMs: number | undefined;

  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1;
    if (step > 0) emit({ type: 'reset' });
    steps++;

    const tStep = Date.now();
    let stepTtft: number | undefined;
    const res = await deps.llm.complete(
      { system, messages, tools: [WEB_SEARCH_TOOL], allowTools: !last, maxTokens: 2500, signal },
      (delta) => {
        if (stepTtft === undefined) stepTtft = Date.now() - tStep;
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
        emit({ type: 'text', delta });
      },
    );

    const calls = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    answer = res.content
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    emit({ type: 'step', n: step + 1, ms: Date.now() - tStep, ttftMs: stepTtft, toolCalls: calls.length });
    if (calls.length === 0) break;

    // 3. Run every search the model asked for, in parallel.
    messages.push({ role: 'assistant', content: res.content });
    const results = await Promise.all(
      calls.map(async (call): Promise<Block> => {
        const params = call.name === 'web_search' ? parseParams(call.input) : `unknown tool ${call.name}`;
        if (typeof params === 'string') return { type: 'tool_result', tool_use_id: call.id, content: `Error: ${params}`, is_error: true };
        if (searchCount >= maxSearches) {
          return { type: 'tool_result', tool_use_id: call.id, content: 'Search budget for this message is used up. Answer now with what you have and say what you could not verify.', is_error: true };
        }
        searchCount++;
        emit({ type: 'status', text: `Searching: ${params.query}` });
        const tTool = Date.now();
        try {
          const found = await deps.search.search(params, signal);
          searches.push({ query: params.query, since: params.since, results: found });
          emit({ type: 'tool', query: params.query, since: params.since, ms: Date.now() - tTool, results: found.length });
          return { type: 'tool_result', tool_use_id: call.id, content: formatResults(params.query, found) };
        } catch (err) {
          if (signal?.aborted) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          emit({ type: 'tool', query: params.query, since: params.since, ms: Date.now() - tTool, results: 0, error: msg.slice(0, 160) });
          return { type: 'tool_result', tool_use_id: call.id, content: `Search failed (${msg}). Tell the user what you could not verify; do not guess.`, is_error: true };
        }
      }),
    );
    messages.push({ role: 'user', content: results });
    emit({ type: 'sources', sources: collectSources(searches) });
    answer = ''; // a step that ended in tool calls is not the answer
  }

  // Claim ledger: split it off the visible answer and let code adjudicate every verdict.
  const parsed = parseLedger(answer);
  answer = parsed.clean;

  if (!answer.trim()) answer = "I couldn't produce an answer for that. Please try rephrasing.";

  // Citation guard: any link not found in this turn's results or in the memory we showed the model.
  const known = [
    ...searches.flatMap((s) => s.results.map((r) => r.url)),
    ...memory.turns.flatMap((t) => t.searches.flatMap((s) => s.results.map((r) => r.url))),
  ];
  const unverified = unverifiedLinks(answer, known);
  const resultsText = searches.flatMap((s) => s.results.map((r) => `${r.title} ${r.snippet}`)).join('\n');
  const memoryText = memory.turns.map((t) => `${t.user}\n${t.assistant}`).join('\n');
  const figures = checkFigures(answer, resultsText, memoryText);
  const ledger = adjudicate(parsed.raw, {
    resultsText,
    resultUrls: searches.flatMap((s) => s.results.map((r) => r.url)),
    memoryUrls: memory.turns.flatMap((t) => t.searches.flatMap((s) => s.results.map((r) => r.url))),
    memoryText,
  });
  if (ledger.length) emit({ type: 'ledger', items: ledger });

  const ms = Date.now() - started;
  const turn: TurnRecord = {
    id: randomUUID().slice(0, 8),
    conversationId,
    ts: now.toISOString(),
    tz,
    user: text,
    assistant: answer,
    searches: searches.map((s) => ({ ...s, results: s.results.map((r) => ({ ...r, snippet: r.snippet.slice(0, 300) })) })),
    ...(ledger.length ? { ledger } : {}),
    meta: { ms, steps, searches: searchCount, ttftMs: firstTokenMs },
  };
  deps.store.add(turn);
  emit({ type: 'done', turnId: turn.id, searches: searchCount, steps, ms, ttftMs: firstTokenMs, unverified, figures });
  return turn;
}
