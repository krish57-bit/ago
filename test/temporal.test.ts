import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatStamp, resolveTimeRefs } from '../src/memory/temporal.js';

// Tuesday 10 Nov 2026, 15:00 in Kolkata.
const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T09:30:00Z');
const labels = (q: string) => resolveTimeRefs(q, NOW, TZ).map((w) => w.label);

test('bare weekday = most recent one strictly before today', () => {
  assert.deepEqual(labels('On Monday we shortlisted 5 CRM tools'), ['Mon 9 Nov 2026']);
  assert.deepEqual(labels('On Tuesday we talked'), ['Tue 3 Nov 2026']); // today is Tuesday
});
test('"last Tuesday"', () => assert.deepEqual(labels('Last Tuesday I asked you about Postgres hosting'), ['Tue 3 Nov 2026']));
test('explicit date without year', () => {
  assert.deepEqual(labels('What did I ask you on 3 November?'), ['Tue 3 Nov 2026']);
  assert.deepEqual(labels('what did I ask on 12 December'), ['Fri 12 Dec 2025']); // future this year -> last year
});
test('yesterday / N days ago', () => {
  assert.deepEqual(labels('yesterday'), ['Mon 9 Nov 2026']);
  assert.deepEqual(labels('3 days ago'), ['Sat 7 Nov 2026']);
});
test('last week is the previous Mon-Sun', () => {
  const [w] = resolveTimeRefs('what did we cover last week', NOW, TZ);
  assert.equal(formatStamp(new Date(w.startMs), TZ), 'Mon 2 Nov 2026, 00:00');
  assert.equal(formatStamp(new Date(w.endMs), TZ), 'Mon 9 Nov 2026, 00:00');
});
test('windows are in the USER timezone, not UTC', () => {
  const [w] = resolveTimeRefs('on Monday', NOW, TZ);
  assert.equal(new Date(w.startMs).toISOString(), '2026-11-08T18:30:00.000Z'); // 00:00 IST
});
test('verbs and future dates are not dates', () => {
  assert.deepEqual(labels('I may switch tools'), []);
  assert.deepEqual(labels('what is planned for next Friday'), []);
});
