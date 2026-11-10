/** Tiny structured logger: one line per event, JSON when LOG_FORMAT=json, silent when LOG_LEVEL=silent. */
const silent = (process.env.LOG_LEVEL ?? '').toLowerCase() === 'silent';
const json = (process.env.LOG_FORMAT ?? '').toLowerCase() === 'json';

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  if (silent) return;
  const out = level === 'error' ? console.error : console.log;
  if (json) return out(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  const extra = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  out(`${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? '  ' + extra : ''}`);
}
