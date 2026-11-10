/** Fixed-window in-memory rate limiter. One process, one user: no need for anything fancier. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();

  constructor(
    private limit: number,
    private windowMs = 60_000,
  ) {}

  /** limit <= 0 disables limiting. */
  check(key: string, now = Date.now()): { ok: boolean; retryAfterS: number } {
    if (this.limit <= 0) return { ok: true, retryAfterS: 0 };
    const cur = this.hits.get(key);
    if (!cur || now - cur.start >= this.windowMs) {
      this.hits.set(key, { start: now, n: 1 });
      return { ok: true, retryAfterS: 0 };
    }
    cur.n++;
    if (cur.n <= this.limit) return { ok: true, retryAfterS: 0 };
    return { ok: false, retryAfterS: Math.ceil((cur.start + this.windowMs - now) / 1000) };
  }
}
