import type { SearchParams, SearchProvider, SearchResult } from '../types.js';

export class TavilySearch implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(p: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query: p.query,
      topic: p.topic ?? 'general',
      search_depth: p.depth ?? 'basic',
      max_results: 6,
      include_answer: false,
      include_raw_content: false,
    };
    if (p.since) body.start_date = p.since;
    if (p.until) body.end_date = p.until;

    const timeout = AbortSignal.timeout(12_000);
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { results?: { title?: string; url: string; content?: string; published_date?: string }[] };
    return (json.results ?? []).map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: (r.content ?? '').slice(0, 900),
      publishedDate: toIsoDay(r.published_date),
    }));
  }
}

/** Providers return dates as ISO, RFC 2822 ("Mon, 09 Nov 2026 …") or junk. Normalise to YYYY-MM-DD or drop. */
export function toIsoDay(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
