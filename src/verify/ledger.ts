/**
 * Claim ledger: structured facts an answer asserts, adjudicated by code.
 *
 * The model writes a small <ledger> JSON block after its answer (no extra model call). Code then makes
 * sure no verdict is stronger than its evidence:
 *   - "unchanged"/"changed" need a `now` value that appears in THIS turn's search results
 *     (figures) or a source URL that this turn actually retrieved. Otherwise -> "unverified".
 *   - was/now figures are compared by code: if they differ the item is "changed", if they match
 *     it is "unchanged", whatever the model said.
 *   - a source URL the model could not have seen is dropped.
 * Stored on the turn, so the NEXT "is it still correct?" starts from recorded values, not prose.
 */
import { checkFigures, figuresOf, normUrl } from './sources.js';
import type { LedgerItem, LedgerStatus } from '../types.js';

const BLOCK = /<ledger>([\s\S]*?)<\/ledger>/i;

/** Splits the model output into the visible answer and the raw ledger JSON (null if absent/invalid). */
export function parseLedger(text: string): { clean: string; raw: unknown[] | null } {
  const m = BLOCK.exec(text);
  // Also strip an unterminated block (model cut off) so it never leaks into the answer.
  const clean = text.replace(BLOCK, '').replace(/\s*<ledger>[\s\S]*$/i, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  if (!m) return { clean, raw: null };
  const body = m[1].replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(body);
    return { clean, raw: Array.isArray(parsed) ? parsed : null };
  } catch {
    return { clean, raw: null };
  }
}

const str = (v: unknown, n = 160): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
const STATUSES = new Set<LedgerStatus>(['new', 'unchanged', 'changed', 'unverified']);
const canonSet = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase().replace(/[\s,]/g, '').replace(/^v(?=\d)/, '')));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export interface AdjudicationContext {
  /** Titles + snippets returned by this turn's searches. */
  resultsText: string;
  /** URLs returned by this turn's searches. */
  resultUrls: string[];
  /** URLs from remembered turns shown to the model. */
  memoryUrls: string[];
  /** Text of the remembered turns shown to the model (the only legitimate source of a `was` value). */
  memoryText: string;
}

export function adjudicate(raw: unknown[] | null, ctx: AdjudicationContext, max = 10): LedgerItem[] {
  if (!raw) return [];
  const results = new Set(ctx.resultUrls.map(normUrl));
  const memory = new Set(ctx.memoryUrls.map(normUrl));
  const out: LedgerItem[] = [];

  for (const r of raw.slice(0, max)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const item = str(o.item, 120);
    if (!item) continue;
    let was = str(o.was);
    const now = str(o.now);
    let status: LedgerStatus = STATUSES.has(o.status as LedgerStatus) ? (o.status as LedgerStatus) : was ? 'unverified' : 'new';
    let source = str(o.source, 300);
    const notes: string[] = [];
    let adjusted: string | undefined;

    if (source && !results.has(normUrl(source)) && !memory.has(normUrl(source))) {
      notes.push('source link was not in any search result and was removed');
      source = undefined;
    }

    // `was` must come from memory. A previous value the model could not have read is dropped:
    // without a recorded baseline nothing can be called "unchanged" or "changed".
    let lostBaseline = false;
    if (was && figuresOf(was).length) {
      const c = checkFigures(was, '', ctx.memoryText);
      if (c.unsupported.length) {
        notes.push(`earlier value "${was}" is not in memory, so it was removed`);
        was = undefined;
        lostBaseline = true;
      }
    }

    // Is the current value confirmed by something retrieved this turn?
    const nowFigs = now ? figuresOf(now) : [];
    let grounded: boolean;
    if (nowFigs.length) {
      const c = checkFigures(now!, ctx.resultsText, '');
      grounded = c.fromMemory.length === 0 && c.unsupported.length === 0;
    } else {
      grounded = !!source && results.has(normUrl(source));
    }

    if (lostBaseline && (status === 'unchanged' || status === 'changed')) {
      adjusted = `no recorded earlier value to compare against`;
      status = grounded ? 'new' : 'unverified';
    } else if ((status === 'unchanged' || status === 'changed') && !grounded) {
      adjusted = `was labelled "${status}", but nothing retrieved this turn confirms the current value`;
      status = 'unverified';
    } else if (status !== 'new' && status !== 'unverified' && was && now) {
      const a = canonSet(figuresOf(was));
      const b = canonSet(figuresOf(now));
      if (a.size && b.size) {
        const equal = sameSet(a, b);
        if (equal && status === 'changed') (status = 'unchanged'), (adjusted = 'figures are identical, so not changed');
        if (!equal && status === 'unchanged') (status = 'changed'), (adjusted = 'figures differ, so not unchanged');
      }
    }

    out.push({ item, was, now, status, source, note: [str(o.note, 200), ...notes].filter(Boolean).join(' · ') || undefined, adjusted, grounded });
  }
  return out;
}
