import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { AnthropicLLM, OpenAICompatLLM, type LLM } from './agent/llm.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './lib/logger.js';
import { MemoryStore } from './memory/store.js';
import { CachedSearch } from './search/cache.js';
import { MockSearch } from './search/mock.js';
import { TavilySearch } from './search/tavily.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; displayName?: string };
const name = pkg.displayName ?? 'Ago';

const missing: string[] = [];
const useOpenAI = config.llmProvider === 'openai';
if (useOpenAI && !config.llmApiKey) missing.push('LLM_API_KEY');
if (!useOpenAI && !config.anthropicKey) missing.push('ANTHROPIC_API_KEY');
if (config.searchProvider === 'tavily' && !config.tavilyKey) missing.push('TAVILY_API_KEY');

const llm: LLM | null = useOpenAI
  ? config.llmApiKey ? new OpenAICompatLLM(config.llmApiKey, config.model, config.llmBaseUrl, config.reasoningEffort) : null
  : config.anthropicKey ? new AnthropicLLM(config.anthropicKey, config.model) : null;
const search = new CachedSearch(config.searchProvider === 'mock' ? new MockSearch() : new TavilySearch(config.tavilyKey ?? ''));
const store = new MemoryStore(join(config.dataDir, 'memory.jsonl'));

const app = createApp({
  store,
  llm,
  search,
  missing,
  root,
  info: { name, version: pkg.version, model: config.model.split(',')[0].trim(), provider: config.llmProvider, search: config.searchProvider, tz: config.defaultTz },
  options: { maxSteps: config.maxSteps, maxSearches: config.maxSearches, allowClockOverride: config.allowClockOverride, rateLimitPerMin: config.rateLimitPerMin },
});

const server = serve({ fetch: app.fetch, port: config.port }, (i) => {
  log('info', `${name} ${pkg.version} listening`, { url: `http://localhost:${i.port}`, provider: config.llmProvider, model: config.model.split(',')[0].trim(), search: config.searchProvider, memory: `${store.all().length} turns` });
  if (missing.length) log('warn', `Missing ${missing.join(', ')}: copy .env.example to .env and fill it in`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log('error', `Port ${config.port} is already in use. Stop the other process or set PORT.`);
  else log('error', err.message);
  process.exit(1);
});

// Graceful shutdown: stop accepting connections, let in-flight answers finish (max 10 s).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', `${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
