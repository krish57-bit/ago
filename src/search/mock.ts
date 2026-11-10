import type { SearchParams, SearchProvider, SearchResult } from '../types.js';

/** Offline provider for tests and keyless runs. Returns clearly-labelled placeholder results. */
export class MockSearch implements SearchProvider {
  calls: SearchParams[] = [];
  async search(p: SearchParams): Promise<SearchResult[]> {
    this.calls.push(p);
    return [
      {
        title: `Mock result for "${p.query}"`,
        url: `https://example.com/mock?q=${encodeURIComponent(p.query)}`,
        snippet: `This is placeholder content from the mock search provider for: ${p.query}. Set SEARCH_PROVIDER=tavily for real results.`,
        publishedDate: p.since,
      },
    ];
  }
}
