import type { SearchParams, SearchProvider, SearchResult } from '../types.js';

/**
 * Wraps any provider with a short-TTL cache and in-flight de-duplication.
 * Follow-ups ("and for 30 seats?") and parallel duplicate calls cost 0 ms.
 * The TTL is short because the whole point of the agent is fresh facts.
 */
export class CachedSearch implements SearchProvider {
  private cache = new Map<string, { at: number; value: Promise<SearchResult[]> }>();

  constructor(
    private inner: SearchProvider,
    private ttlMs = 10 * 60_000,
    private max = 200,
  ) {}

  search(p: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    const key = JSON.stringify([p.query.trim().toLowerCase(), p.topic ?? 'general', p.since ?? '', p.until ?? '', p.depth ?? 'basic']);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const value = this.inner.search(p, signal);
    this.cache.set(key, { at: Date.now(), value });
    // Never cache failures.
    value.catch(() => this.cache.delete(key));
    if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
