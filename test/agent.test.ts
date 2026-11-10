import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type AgentEvent } from '../src/agent/agent.js';
import type { LLM, LLMRequest, LLMResponse } from '../src/agent/llm.js';
import { sampleTurns } from '../src/sample.js';
import { MemoryStore } from '../src/memory/store.js';
import { MockSearch } from '../src/search/mock.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T09:30:00Z');

class ScriptedLLM implements LLM {
  requests: LLMRequest[] = [];
  constructor(private script: ((req: LLMRequest) => LLMResponse)[]) {}
  async complete(req: LLMRequest, onText: (d: string) => void): Promise<LLMResponse> {
    this.requests.push(structuredClone(req));
    const res = this.script[this.requests.length - 1](req);
    for (const b of res.content) if (b.type === 'text') onText(b.text);
    return res;
  }
}

test('memory + parallel search + persistence', async () => {
  const store = new MemoryStore();
  for (const t of sampleTurns(NOW, TZ)) store.add(t);
  const search = new MockSearch();
  const llm = new ScriptedLLM([
    () => ({
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'a', name: 'web_search', input: { query: 'HubSpot pricing', since: '2026-11-09' } },
        { type: 'tool_use', id: 'b', name: 'web_search', input: { query: 'Pipedrive pricing', since: 'not-a-date' } },
      ],
    }),
    () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'No changes found.' }] }),
  ]);
  const events: AgentEvent[] = [];
  const turn = await runTurn({ llm, search, store }, { conversationId: 'c1', text: 'On Monday we shortlisted 5 CRM tools. Has any changed pricing?', tz: TZ, now: NOW }, (e) => events.push(e));

  // Memory resolved by code and present in the FIRST model call, with the current time.
  const sys = llm.requests[0].system.map((s) => s.text).join('\n');
  assert.match(sys, /Tuesday, 10 November 2026/);
  assert.match(sys, /Mon 9 Nov 2026/);
  assert.match(sys, /HubSpot/);
  // Both searches ran; invalid date filter was dropped, valid one kept.
  assert.equal(search.calls.length, 2);
  assert.equal(search.calls[0].since, '2026-11-09');
  assert.equal(search.calls[1].since, undefined);
  // Preamble text from the tool step is not the answer.
  assert.equal(turn.assistant, 'No changes found.');
  assert.ok(events.some((e) => e.type === 'reset'));
  // Persisted with the searches, so a later "is that still correct?" can see what we knew.
  assert.equal(store.conversation('c1').length, 1);
  assert.equal(store.conversation('c1')[0].searches.length, 2);
  // Last step cannot call tools.
  assert.equal(llm.requests[0].allowTools, true);
});

test('search budget forces a final answer and failures do not crash the turn', async () => {
  const store = new MemoryStore();
  const failing = { search: async () => { throw new Error('boom'); } };
  const loop = () => ({ stopReason: 'tool_use', content: [{ type: 'tool_use' as const, id: 'x', name: 'web_search', input: { query: 'q' } }] });
  const llm = new ScriptedLLM([loop, loop, () => ({ stopReason: 'end_turn', content: [{ type: 'text' as const, text: 'Could not verify.' }] })]);
  const turn = await runTurn({ llm, search: failing, store, maxSteps: 3 }, { conversationId: 'c2', text: 'latest news?', tz: TZ, now: NOW }, () => {});
  assert.equal(turn.assistant, 'Could not verify.');
  assert.equal(llm.requests[2].allowTools, false);
  const toolResult = JSON.stringify(llm.requests[1].messages.at(-1));
  assert.match(toolResult, /Search failed/);
});

test('follow-ups in the same conversation see prior turns', async () => {
  const store = new MemoryStore();
  const llm = new ScriptedLLM([
    () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Hi!' }] }),
    () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Still here.' }] }),
  ]);
  const deps = { llm, search: new MockSearch(), store };
  await runTurn(deps, { conversationId: 'c3', text: 'hello', tz: TZ, now: NOW }, () => {});
  await runTurn(deps, { conversationId: 'c3', text: 'you there?', tz: TZ, now: new Date(NOW.getTime() + 60_000) }, () => {});
  assert.deepEqual(llm.requests[1].messages.map((m) => m.content), ['hello', 'Hi!', 'you there?']);
});

test('trace events, sources and the citation guard', async () => {
  const store = new MemoryStore();
  const search = new MockSearch();
  const llm = new ScriptedLLM([
    () => ({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'web_search', input: { query: 'foo' } }] }),
    () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Real ([src](https://example.com/mock?q=foo)) and invented ([x](https://made-up.test/pricing)).' }] }),
  ]);
  const events: AgentEvent[] = [];
  await runTurn({ llm, search, store }, { conversationId: 'c9', text: 'foo?', tz: TZ, now: NOW }, (e) => events.push(e));
  const types = events.map((e) => e.type);
  assert.deepEqual(types.filter((t) => t !== 'text'), ['memory', 'step', 'status', 'tool', 'sources', 'reset', 'step', 'done']);
  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.deepEqual(done.unverified, ['https://made-up.test/pricing']); // flagged, not hidden
  assert.deepEqual(done.figures, { fromMemory: [], unsupported: [] });
  assert.equal(done.searches, 1);
  assert.ok(store.all()[0].meta!.ms >= 0);
});

test('forgetting a turn removes it from memory', () => {
  const store = new MemoryStore();
  for (const t of sampleTurns(NOW, TZ)) store.add(t);
  const id = store.all()[0].id;
  assert.equal(store.remove(id), true);
  assert.equal(store.all().length, 2);
  assert.equal(store.remove('nope'), false);
});

test('figure guard separates "from memory only" from "unsupported" and ignores confirmed figures', async () => {
  const { checkFigures } = await import('../src/sources.js');
  const r = checkFigures(
    'HubSpot is $20/seat ([x](https://a.test/v1.2.3)), Pipedrive $14/seat, a 15% rise, total $9,999, now on v26.13.0.',
    'HubSpot pricing: $20 per seat per month. Node v26.13.0 released.',
    'Earlier you were told Pipedrive is $14/seat.',
  );
  assert.deepEqual(r.fromMemory, ['$14']);
  assert.deepEqual(r.unsupported.sort(), ['$9,999', '15%'].sort()); // URL version ignored, confirmed $20 and v26.13.0 fine
});
