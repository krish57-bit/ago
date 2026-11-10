import type { SearchRecord } from '../types.js';

export interface Source {
  n: number;
  title: string;
  url: string;
  domain: string;
  date?: string;
}

/** Canonical form for comparing URLs: no scheme, www, hash, tracking params or trailing slash. */
export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

export function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

/** De-duplicated, numbered list of everything the searches returned (the citation universe). */
export function collectSources(searches: SearchRecord[]): Source[] {
  const seen = new Map<string, Source>();
  for (const s of searches)
    for (const r of s.results) {
      const k = normUrl(r.url);
      if (!seen.has(k)) seen.set(k, { n: seen.size + 1, title: r.title, url: r.url, domain: domainOf(r.url), date: r.publishedDate });
    }
  return [...seen.values()];
}

/** Every URL the answer links to (markdown links and bare URLs). */
export function answerLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/(?<![(\w])https?:\/\/[^\s)\]>]+/g)) out.add(m[0].replace(/[.,;]+$/, ''));
  return [...out];
}

/**
 * Citation guard: links in the answer that appear in NO search result and NO remembered turn.
 * Those are the model's own recollection of a URL, i.e. possibly invented. Flagged, not hidden.
 */
export function unverifiedLinks(text: string, known: Iterable<string>): string[] {
  const set = new Set([...known].map(normUrl));
  return answerLinks(text).filter((u) => !set.has(normUrl(u)));
}

// ---------- figure grounding ----------
// The failure that hurts most in "has anything changed?" answers: the model repeats an OLD figure from
// memory and labels it "unchanged". Cheap deterministic guard: every price / percentage / version in
// the answer must appear in something retrieved THIS turn; figures that appear only in memory are
// reported separately so the UI can say "this came from earlier, not re-verified".

const FIGURE_RE = /\$\s?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d+(?:\.\d+)?\s?%|\bv?\d+\.\d+\.\d+(?:\.\d+)?\b/g;

const canon = (s: string) => s.toLowerCase().replace(/[\s,]/g, '').replace(/^v(?=\d)/, '');

export function figuresOf(text: string): string[] {
  // Ignore URLs: version-like and numeric path segments are not claims.
  const noUrls = text.replace(/\]\(https?:[^)]*\)/g, ']').replace(/https?:\/\/\S+/g, ' ');
  return [...new Set(noUrls.match(FIGURE_RE) ?? [])];
}

export interface FigureCheck {
  /** Appears in the answer and in this turn's search results: fine. */
  /** Appears only in remembered turns, not re-confirmed this turn. */
  fromMemory: string[];
  /** Appears nowhere we gave the model (may be arithmetic, e.g. 14 × 20, or invented). */
  unsupported: string[];
}

export function checkFigures(answer: string, resultsText: string, memoryText: string): FigureCheck {
  const hay = (t: string) => canon(t);
  const inResults = hay(resultsText);
  const inMemory = hay(memoryText);
  const out: FigureCheck = { fromMemory: [], unsupported: [] };
  for (const f of figuresOf(answer)) {
    const c = canon(f);
    if (inResults.includes(c)) continue;
    (inMemory.includes(c) ? out.fromMemory : out.unsupported).push(f);
  }
  return out;
}
