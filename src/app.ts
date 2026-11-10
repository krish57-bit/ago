import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { runTurn } from './agent/agent.js';
import type { LLM } from './agent/llm.js';
import { log } from './lib/logger.js';
import { MemoryStore } from './memory/store.js';
import { isValidTz } from './memory/temporal.js';
import { RateLimiter } from './lib/ratelimit.js';
import { sampleTurns } from './memory/sample.js';
import { collectSources } from './verify/sources.js';
import type { SearchProvider } from './types.js';

export interface AppDeps {
  store: MemoryStore;
  /** null when no model key is configured: the UI still loads and explains what is missing. */
  llm: LLM | null;
  search: SearchProvider;
  /** Names of missing environment variables (for the health endpoint / UI banner). */
  missing: string[];
  info: { name: string; version: string; model: string; provider: string; search: string; tz: string };
  options: { maxSteps: number; maxSearches: number; allowClockOverride: boolean; rateLimitPerMin: number };
  /** Absolute path of the project root (for static assets). */
  root: string;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp(deps: AppDeps): Hono {
  const { store, llm, search, missing, info, options, root } = deps;
  const app = new Hono();
  const limiter = new RateLimiter(options.rateLimitPerMin);
  const startedAt = Date.now();

  // ---------- cross-cutting: security, limits, logging ----------
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"], // all JS is external: no inline script, no eval
        styleSrc: ["'self'", "'unsafe-inline'"], // style="" attributes set by the UI (bar widths, avatar hues)
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
      xFrameOptions: 'DENY',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    }),
  );
  app.use('/api/*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request too large.' }, 413) }));

  // Drive-by protection: a web page on another origin must not be able to call this local API.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && origin && new URL(origin).host !== c.req.header('host')) return c.json({ error: 'Cross-origin request blocked.' }, 403);
    await next();
  });

  app.use('*', async (c, next) => {
    const t = Date.now();
    await next();
    if (c.req.path.startsWith('/api/')) log('info', `${c.req.method} ${c.req.path}`, { status: c.res.status, ms: Date.now() - t });
  });

  app.onError((err, c) => {
    log('error', 'unhandled', { path: c.req.path, err: err.message });
    return c.json({ error: 'Internal error.' }, 500);
  });

  // ---------- static assets ----------
  const asset = (rel: string) => {
    const body = readFileSync(join(root, rel));
    return new Response(body, { headers: { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
  };
  app.get('/', () => asset('src/public/index.html'));
  for (const f of ['app.js', 'app.css', 'favicon.svg']) app.get(`/${f}`, () => asset(`src/public/${f}`));
  app.get('/vendor/marked.js', () => asset('node_modules/marked/lib/marked.umd.js'));
  app.get('/vendor/purify.js', () => asset('node_modules/dompurify/dist/purify.min.js'));

  // ---------- API ----------
  app.get('/api/health', (c) =>
    c.json({ ok: missing.length === 0, missing, ...info, uptimeS: Math.round((Date.now() - startedAt) / 1000), turns: store.all().length }),
  );

  app.get('/api/history', (c) => {
    const id = c.req.query('conversationId') ?? '';
    return c.json(
      store.conversation(id).map((t) => ({ id: t.id, ts: t.ts, user: t.user, assistant: t.assistant, sources: collectSources(t.searches), ledger: t.ledger ?? [], searches: t.searches.map((s) => s.query), meta: t.meta })),
    );
  });

  // Everything the agent remembers, newest first, so the user can see (and delete) it.
  app.get('/api/memory', (c) =>
    c.json(
      [...store.all()]
        .reverse()
        .slice(0, 300)
        .map((t) => ({ id: t.id, conversationId: t.conversationId, ts: t.ts, user: t.user, answer: t.assistant.slice(0, 240), sources: collectSources(t.searches).length })),
    ),
  );

  // Your data, portable: the full turn log as a download.
  app.get('/api/export', (c) => {
    const stamp = new Date().toISOString().slice(0, 10);
    c.header('content-disposition', `attachment; filename="${info.name.toLowerCase()}-memory-${stamp}.json"`);
    return c.json({ exportedAt: new Date().toISOString(), version: info.version, turns: store.all() });
  });

  app.get('/api/conversations', (c) => {
    const by = new Map<string, { id: string; title: string; ts: string; turns: number }>();
    for (const t of store.all()) {
      const cur = by.get(t.conversationId);
      if (cur) {
        cur.turns++;
        cur.ts = t.ts;
      } else by.set(t.conversationId, { id: t.conversationId, title: t.user.slice(0, 80), ts: t.ts, turns: 1 });
    }
    return c.json([...by.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50));
  });

  app.delete('/api/turns/:id', (c) => c.json({ removed: store.remove(c.req.param('id')) }));
  app.delete('/api/conversations/:id', (c) => c.json({ removed: store.removeConversation(c.req.param('id')) }));

  // Sample history dated relative to today, so the memory features can be tried on day one.
  app.post('/api/sample', (c) => {
    const have = new Set(store.all().map((t) => t.conversationId));
    let added = 0;
    for (const t of sampleTurns(new Date(), info.tz)) if (!have.has(t.conversationId)) (store.add(t), added++);
    return c.json({ added });
  });

  // Import historical turns with explicit timestamps (evals, migrations).
  app.post('/api/seed', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { turns?: { ts: string; user: string; assistant: string; conversationId?: string; tz?: string }[] };
    let added = 0;
    for (const t of body.turns ?? []) {
      if (!t?.ts || !t.user || !t.assistant || Number.isNaN(Date.parse(t.ts))) continue;
      store.add({ id: randomUUID().slice(0, 8), conversationId: t.conversationId ?? `seed-${t.ts}`, ts: new Date(t.ts).toISOString(), tz: t.tz ?? info.tz, user: t.user, assistant: t.assistant, searches: [] });
      added++;
    }
    return c.json({ added });
  });

  app.post('/api/chat', async (c) => {
    if (!llm || missing.length) return c.json({ error: `Missing configuration: ${missing.join(', ')}. See .env.example.` }, 503);

    const ip = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'local';
    const gate = limiter.check(ip);
    if (!gate.ok) {
      c.header('retry-after', String(gate.retryAfterS));
      return c.json({ error: `Too many requests. Try again in ${gate.retryAfterS}s.` }, 429);
    }

    const body = (await c.req.json().catch(() => ({}))) as { message?: string; conversationId?: string; tz?: string; now?: string };
    const message = (body.message ?? '').trim();
    if (!message) return c.json({ error: 'message is required' }, 400);
    if (message.length > 4000) return c.json({ error: 'Message too long (max 4000 characters).' }, 413);

    const tz = isValidTz(body.tz) ? body.tz : info.tz;
    const override = options.allowClockOverride && body.now ? new Date(body.now) : null;
    const now = override && !Number.isNaN(override.getTime()) ? override : new Date();
    const conversationId = body.conversationId || randomUUID();

    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      // Events are written strictly in order and fully flushed before the stream closes.
      let chain: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => (chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })));
      try {
        await runTurn(
          { llm, search, store, maxSteps: options.maxSteps, maxSearches: options.maxSearches },
          { conversationId, text: message, tz, now, signal: ctrl.signal },
          (e) => {
            if (e.type === 'done') log('info', 'turn', { searches: e.searches, steps: e.steps, ms: e.ms, ttft: e.ttftMs ?? '-', unverified: e.unverified.length });
            void send(e.type, e);
          },
        );
        await chain;
      } catch (err) {
        if (!ctrl.signal.aborted) {
          log('error', 'turn failed', { err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
          await send('error', { message: err instanceof Error ? err.message : 'Something went wrong.' });
        }
      }
    });
  });

  return app;
}
