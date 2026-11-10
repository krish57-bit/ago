import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type AgentEvent } from '../src/agent/agent.js';
import type { LLM, LLMRequest, LLMResponse } from '../src/agent/llm.js';
import { adjudicate, parseLedger } from '../src/ledger.js';
import { MemoryStore } from '../src/memory/store.js';
import { MockSearch } from '../src/search/mock.js';

const ctx = {
  resultsText: 'HubSpot Starter is now $25 per seat per month. Pipedrive Essential costs $14 per seat.',
  resultUrls: ['https://hubspot.com/pricing', 'https://www.pipedrive.com/pricing/'],
  memoryUrls: ['https://old.example/page'],
  memoryText: 'Earlier you were told: HubSpot $20, Pipedrive $14, Zoho $16 per seat.',
};

test('parseLedger splits the block off, tolerates fences, and never leaks a cut-off block', () => {
  const a = parseLedger('Answer.\n\n<ledger>```json\n[{"item":"x","now":"$1"}]\n```</ledger>');
  assert.equal(a.clean, 'Answer.');
  assert.equal(a.raw?.length, 1);
  const b = parseLedger('Answer.\n<ledger>[{"item":"x"');
  assert.equal(b.clean, 'Answer.');
  assert.equal(b.raw, null);
  assert.equal(parseLedger('<ledger>not json</ledger>Hi').raw, null);
  assert.equal(parseLedger('No block here').clean, 'No block here');
});

test('"unchanged" without current evidence is downgraded to unverified', () => {
  const [j] = adjudicate([{ item: 'Zoho Standard price', was: '$16', now: '$16', status: 'unchanged' }], ctx); // $16 appears in no result
  assert.equal(j.status, 'unverified');
  assert.match(j.adjusted!, /nothing retrieved this turn/);
  assert.equal(j.grounded, false);
  const [k] = adjudicate([{ item: 'Pipedrive Essential', was: '$14', now: '$14', status: 'unchanged' }], ctx); // $14 is in the results
  assert.equal(k.status, 'unchanged');
  assert.equal(k.grounded, true);
});

test('code compares was/now figures and overrides a wrong label', () => {
  const [a, b] = adjudicate(
    [
      { item: 'HubSpot Starter', was: '$20', now: '$25', status: 'unchanged', source: 'https://hubspot.com/pricing' },
      { item: 'Pipedrive Essential', was: '$14', now: '$14', status: 'changed', source: 'https://pipedrive.com/pricing' },
    ],
    ctx,
  );
  assert.equal(a.status, 'changed');
  assert.match(a.adjusted!, /figures differ/);
  assert.equal(b.status, 'unchanged');
  assert.match(b.adjusted!, /identical/);
  assert.equal(b.source, 'https://pipedrive.com/pricing'); // www/trailing slash differences still match
});

test('invented source URLs are dropped; memory URLs are allowed; non-figure items need a retrieved source', () => {
  const [a, b, c] = adjudicate(
    [
      { item: 'a', now: '$25', status: 'new', source: 'https://made-up.test/x' },
      { item: 'b', now: '$25', status: 'new', source: 'https://old.example/page' },
      { item: 'SSO included', was: 'no', now: 'yes, on Pro', status: 'changed', source: 'https://hubspot.com/pricing' },
    ],
    ctx,
  );
  assert.equal(a.source, undefined);
  assert.match(a.note!, /removed/);
  assert.equal(b.source, 'https://old.example/page');
  assert.equal(c.status, 'changed'); // no figures, but the source was retrieved this turn
  assert.equal(c.grounded, true);
});

test('malformed items are skipped and the list is capped', () => {
  const raw = [null, 'x', { nope: 1 }, ...Array.from({ length: 20 }, (_, n) => ({ item: `i${n}`, now: '$25' }))];
  assert.equal(adjudicate(raw as unknown[], ctx).length, 7); // cap applies to the first 10 raw entries; 3 were invalid
});

test('end to end: ledger is hidden from the answer, adjudicated, emitted and stored', async () => {
  const store = new MemoryStore();
  const search = new MockSearch();
  let n = 0;
  const llm: LLM = {
    async complete(_req: LLMRequest, onText): Promise<LLMResponse> {
      if (n++ === 0) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'web_search', input: { query: 'foo' } }] };
      const text = 'It is $99 per seat.\n<ledger>[{"item":"Foo price","was":"$99","now":"$99","status":"unchanged"}]</ledger>';
      onText(text);
      return { stopReason: 'end_turn', content: [{ type: 'text', text }] };
    },
  };
  const events: AgentEvent[] = [];
  const turn = await runTurn({ llm, search, store }, { conversationId: 'L', text: 'foo price?', tz: 'UTC', now: new Date() }, (e) => events.push(e));
  assert.equal(turn.assistant, 'It is $99 per seat.');
  const led = events.find((e) => e.type === 'ledger') as Extract<AgentEvent, { type: 'ledger' }>;
  assert.equal(led.items[0].status, 'unverified'); // mock results never contain $99
  assert.deepEqual(store.all()[0].ledger, led.items);
  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.deepEqual(done.figures.unsupported, ['$99']); // the figure guard flags it too
});

test('a "was" value that is not in memory is dropped, so nothing can be called changed/unchanged', () => {
  const [a] = adjudicate([{ item: 'Pipedrive', was: '$0.106', now: '$14', status: 'unchanged', source: 'https://pipedrive.com/pricing' }], ctx);
  assert.equal(a.was, undefined);
  assert.equal(a.status, 'new'); // current value is grounded, but there is no baseline to compare with
  assert.match(a.adjusted!, /no recorded earlier value/);
  assert.match(a.note!, /not in memory/);
});
