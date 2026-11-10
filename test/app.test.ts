import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LLM, LLMResponse } from '../src/agent/llm.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/memory/store.js';
import { RateLimiter } from '../src/ratelimit.js';
import { MockSearch } from '../src/search/mock.js';

process.env.LOG_LEVEL = 'silent';
const root = fileURLToPath(new URL('..', import.meta.url));
const llm: LLM = { async complete(_r, onText): Promise<LLMResponse> { onText('Hello.'); return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Hello.' }] }; } };

function make(over: { llm?: LLM | null; missing?: string[]; rate?: number } = {}) {
  const store = new MemoryStore();
  const app = createApp({
    store,
    llm: over.llm === undefined ? llm : over.llm,
    search: new MockSearch(),
    missing: over.missing ?? [],
    root,
    info: { name: 'Ago', version: '9.9.9', model: 'm', provider: 'openai', search: 'mock', tz: 'UTC' },
    options: { maxSteps: 3, maxSearches: 3, allowClockOverride: false, rateLimitPerMin: over.rate ?? 0 },
  });
  return { app, store };
}
const post = (app: ReturnType<typeof make>['app'], path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:3000', ...headers }, body: JSON.stringify(body) });

test('serves the UI with a strict CSP (no inline script) and hardening headers', async () => {
  const { app } = make();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.doesNotMatch(html, /<script>[^<]/); // all JS is external
  for (const p of ['/app.js', '/app.css', '/favicon.svg', '/vendor/marked.js', '/vendor/purify.js']) assert.equal((await app.request(p)).status, 200, p);
});

test('health reports version, configuration problems and counts', async () => {
  const { app } = make({ missing: ['TAVILY_API_KEY'] });
  const h = await (await app.request('/api/health')).json();
  assert.equal(h.version, '9.9.9');
  assert.equal(h.ok, false);
  assert.deepEqual(h.missing, ['TAVILY_API_KEY']);
});

test('chat refuses politely when keys are missing', async () => {
  const { app } = make({ llm: null, missing: ['LLM_API_KEY'] });
  const res = await post(app, '/api/chat', { message: 'hi' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /LLM_API_KEY/);
});

test('chat streams events, persists the turn, and validates input', async () => {
  const { app, store } = make();
  const res = await post(app, '/api/chat', { message: 'hi', conversationId: 'c1' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /event: done/);
  assert.equal(store.conversation('c1').length, 1);
  assert.equal((await post(app, '/api/chat', { message: '   ' })).status, 400);
  assert.equal((await post(app, '/api/chat', { message: 'x'.repeat(4001) })).status, 413);
  assert.equal((await post(app, '/api/chat', { message: 'x'.repeat(300_000) })).status, 413); // body limit
});

test('cross-origin writes are blocked (a web page cannot drive the local API)', async () => {
  const { app, store } = make();
  store.add({ id: 'a', conversationId: 'c', ts: new Date().toISOString(), tz: 'UTC', user: 'q', assistant: 'a', searches: [] });
  const res = await app.request('/api/turns/a', { method: 'DELETE', headers: { origin: 'https://evil.example', host: 'localhost:3000' } });
  assert.equal(res.status, 403);
  assert.equal(store.all().length, 1);
  const ok = await app.request('/api/turns/a', { method: 'DELETE', headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } });
  assert.equal((await ok.json()).removed, true);
});

test('rate limit returns 429 with Retry-After', async () => {
  const { app } = make({ rate: 2 });
  assert.equal((await post(app, '/api/chat', { message: 'a' })).status, 200);
  assert.equal((await post(app, '/api/chat', { message: 'b' })).status, 200);
  const res = await post(app, '/api/chat', { message: 'c' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('RateLimiter windows reset', () => {
  const r = new RateLimiter(1, 1000);
  assert.equal(r.check('k', 0).ok, true);
  assert.equal(r.check('k', 500).ok, false);
  assert.equal(r.check('k', 1500).ok, true);
  assert.equal(new RateLimiter(0).check('k').ok, true); // 0 disables
});

test('export, sample import (idempotent) and conversation delete', async () => {
  const { app, store } = make();
  assert.equal((await (await post(app, '/api/sample', {})).json()).added, 3);
  assert.equal((await (await post(app, '/api/sample', {})).json()).added, 0);
  const ex = await app.request('/api/export');
  assert.match(ex.headers.get('content-disposition') ?? '', /ago-memory-\d{4}-\d{2}-\d{2}\.json/);
  assert.equal((await ex.json()).turns.length, 3);
  const id = store.all()[0].conversationId;
  const del = await app.request(`/api/conversations/${id}`, { method: 'DELETE', headers: { host: 'localhost:3000' } });
  assert.equal((await del.json()).removed, 1);
  assert.equal(store.all().length, 2);
});
