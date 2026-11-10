/**
 * Live eval: `npm run eval`. Runs the real agent (real model + real search) on scenario
 * shapes from the brief, against an in-memory store seeded with relative-dated history.
 * Checks are deterministic (no LLM judge): behaviour, grounding and latency.
 *   npm run eval            all cases
 *   npm run eval -- crm     only cases whose id contains "crm"
 */
import { runTurn, type AgentEvent } from '../src/agent/agent.js';
import { AnthropicLLM, OpenAICompatLLM, type LLM } from '../src/agent/llm.js';
import { config } from '../src/config.js';
import { sampleTurns } from '../src/memory/sample.js';
import { MemoryStore } from '../src/memory/store.js';
import { CachedSearch } from '../src/search/cache.js';
import { TavilySearch } from '../src/search/tavily.js';

interface Result {
  answer: string;
  searches: number;
  ms: number;
  ttftMs?: number;
  unverified: string[];
  recalled: number;
  windows: string[];
  links: number;
  ledger: import('../src/types.js').LedgerItem[];
}
interface Case {
  id: string;
  ask: string;
  checks: [name: string, test: (r: Result) => boolean][];
}

const has = (r: Result, ...words: string[]) => {
  const text = r.answer + ' ' + r.ledger.map((i) => i.item).join(' '); // facts may live in the ledger table
  return words.every((w) => new RegExp(w, 'i').test(text));
};
const cases: Case[] = [
  {
    id: 'crm-monday',
    ask: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    checks: [
      ['resolved "Monday" and recalled the shortlist', (r) => r.windows.length > 0 && r.recalled === 1],
      ['covers all 5 tools', (r) => has(r, 'HubSpot', 'Pipedrive', 'Zoho', 'Close', 'Salesforce')],
      ['searched (>=3, parallel)', (r) => r.searches >= 3],
      ['every link is grounded', (r) => r.unverified.length === 0 && r.links > 0],
      ['ledger has >=3 items and no ungrounded verdict', (r) => r.ledger.length >= 3 && r.ledger.every((i) => (i.status !== 'changed' && i.status !== 'unchanged') || i.grounded)],
      ['prose does not say "nothing changed" above a change', (r) => !(r.ledger.some((i) => i.status === 'changed') && /\b(none of|no changes?|nothing has changed|all unchanged)\b/i.test(r.answer.slice(0, 220)))],
    ],
  },
  {
    id: 'postgres-tuesday',
    ask: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    checks: [
      ['resolved the date and recalled the chat', (r) => r.windows.length > 0 && r.recalled >= 1],
      ['names providers from the earlier answer', (r) => has(r, 'Neon', 'Supabase')],
      ['re-verified with search', (r) => r.searches >= 2],
      ['every link is grounded', (r) => r.unverified.length === 0],
    ],
  },
  {
    id: 'nov3-recall',
    ask: 'What did I ask you on 3 November? Is your answer still correct today?',
    checks: [
      ['resolved 3 Nov', (r) => r.windows.some((w) => /3 Nov/.test(w))],
      ['recalled the Node LTS question', (r) => has(r, 'Node')],
      ['re-checked live', (r) => r.searches >= 1],
    ],
  },
  {
    id: 'honest-empty-day',
    ask: 'What did I ask you on 20 September?',
    checks: [
      ['does not search for a memory question', (r) => r.searches === 0],
      ['admits there is no record (no invention)', (r) => /(no (record|stored|saved|conversation)|don.t have|do not have|nothing|not stored|no earlier)/i.test(r.answer)],
    ],
  },
  {
    id: 'chitchat-fast',
    ask: 'Thanks, that was helpful!',
    checks: [
      ['no search', (r) => r.searches === 0],
      ['fast (<6s)', (r) => r.ms < 6000],
    ],
  },
  {
    id: 'fresh-fact',
    ask: 'What is the latest stable version of Node.js right now?',
    checks: [
      ['searched', (r) => r.searches >= 1],
      ['cites a source', (r) => r.links >= 1 && r.unverified.length === 0],
      ['reasonably fast (<25s)', (r) => r.ms < 25_000],
    ],
  },
];

function makeLLM(): LLM {
  if (config.llmProvider === 'openai') return new OpenAICompatLLM(config.llmApiKey ?? '', config.model, config.llmBaseUrl, config.reasoningEffort);
  return new AnthropicLLM(config.anthropicKey ?? '', config.model);
}

async function main() {
  const filter = process.argv[2];
  const picked = cases.filter((c) => !filter || c.id.includes(filter));
  const llm = makeLLM();
  const search = new CachedSearch(new TavilySearch(config.tavilyKey ?? ''));
  const tz = config.defaultTz;
  let failed = 0;
  const lat: number[] = [];
  console.log(`\nEval · provider=${config.llmProvider} model=${config.model} tz=${tz}\n`);

  for (const c of picked) {
    const store = new MemoryStore(); // fresh, in-memory
    const now = new Date();
    for (const t of sampleTurns(now, tz)) store.add(t);
    let mem: Extract<AgentEvent, { type: 'memory' }> | undefined;
    let fin: Extract<AgentEvent, { type: 'done' }> | undefined;
    let res: Result;
    try {
      const turn = await runTurn({ llm, search, store }, { conversationId: 'eval', text: c.ask, tz, now }, (e) => {
        if (e.type === 'memory') mem = e;
        if (e.type === 'done') fin = e;
      });
      res = {
        answer: turn.assistant,
        searches: fin?.searches ?? 0,
        ms: fin?.ms ?? 0,
        ttftMs: fin?.ttftMs,
        unverified: fin?.unverified ?? [],
        recalled: mem?.recalled.length ?? 0,
        windows: mem?.windows.map((w) => w.label) ?? [],
        ledger: turn.ledger ?? [],
        links: (turn.assistant.match(/\]\(https?:\/\//g) ?? []).length,
      };
    } catch (err) {
      console.log(`✗ ${c.id}: run failed: ${err instanceof Error ? err.message.slice(0, 160) : err}\n`);
      failed++;
      continue;
    }
    lat.push(res.ms);
    console.log(`${c.id}  (${(res.ms / 1000).toFixed(1)}s, first token ${res.ttftMs ? (res.ttftMs / 1000).toFixed(1) + 's' : '–'}, ${res.searches} searches, ${res.links} links)`);
    for (const [name, test] of c.checks) {
      const ok = test(res);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    }
    if (c.checks.some(([, t]) => !t(res))) console.log('  answer: ' + res.answer.replace(/\s+/g, ' ').slice(0, 260) + '…' + (res.unverified.length ? '\n  unverified links: ' + res.unverified.join(' ') : ''));
    console.log();
    await new Promise((r) => setTimeout(r, Number(process.env.EVAL_DELAY_MS ?? 6000))); // be kind to free-tier rate limits
  }
  lat.sort((a, b) => a - b);
  const p = (q: number) => lat.length ? (lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] / 1000).toFixed(1) + 's' : '–';
  console.log(`latency p50 ${p(0.5)} · p95 ${p(0.95)} · ${failed ? failed + ' check(s) failed' : 'all checks passed'}\n`);
  process.exit(failed ? 1 : 0);
}
main();
