export interface SearchParams {
  query: string;
  topic?: 'general' | 'news';
  /** YYYY-MM-DD: only results published on/after this date. */
  since?: string;
  /** YYYY-MM-DD: only results published on/before this date. */
  until?: string;
  depth?: 'basic' | 'advanced';
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchProvider {
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]>;
}

/** One search the agent ran during a turn (kept so later turns can see what it knew and when). */
export interface SearchRecord {
  query: string;
  since?: string;
  results: SearchResult[];
}

/** One user message + the final assistant answer. The unit of long-term memory. */
export interface TurnRecord {
  id: string;
  conversationId: string;
  /** ISO timestamp of when the user sent the message. */
  ts: string;
  /** IANA timezone the user was in at the time. */
  tz: string;
  user: string;
  assistant: string;
  searches: SearchRecord[];
  /** Performance + shape of the run, for the inspector UI and evals. */
  ledger?: LedgerItem[];
  meta?: { ms: number; steps: number; searches: number; ttftMs?: number };
}

export type LedgerStatus = 'new' | 'unchanged' | 'changed' | 'unverified';

/** One checkable fact the answer asserted, adjudicated by code (see ledger.ts). */
export interface LedgerItem {
  item: string;
  was?: string;
  now?: string;
  status: LedgerStatus;
  /** URL that was actually returned by a search (or recalled from memory). */
  source?: string;
  note?: string;
  /** Present when code overrode the model's own label, and why. */
  adjusted?: string;
  /** Is `now` confirmed by something retrieved this turn? */
  grounded: boolean;
}
