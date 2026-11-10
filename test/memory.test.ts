import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleTurns } from '../src/sample.js';
import { retrieveMemory } from '../src/memory/retrieve.js';
import { MemoryStore } from '../src/memory/store.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T09:30:00Z'); // Tue 10 Nov 2026
function seeded() {
  const s = new MemoryStore();
  for (const t of sampleTurns(NOW, TZ)) s.add(t);
  return s;
}

test('"On Monday we shortlisted…" retrieves Monday\'s CRM turn with absolute date', () => {
  const m = retrieveMemory(seeded(), { query: 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?', now: NOW, tz: TZ });
  assert.match(m.block, /Mon 9 Nov 2026/);
  assert.match(m.block, /HubSpot/);
  assert.match(m.block, /Pipedrive/);
});
test('"Last Tuesday I asked about Postgres hosting"', () => {
  const m = retrieveMemory(seeded(), { query: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', now: NOW, tz: TZ });
  assert.match(m.block, /Tue 3 Nov 2026/);
  assert.match(m.block, /Neon/);
});
test('"What did I ask you on 3 November?" returns that day\'s turn', () => {
  const m = retrieveMemory(seeded(), { query: 'What did I ask you on 3 November? Is your answer still correct today?', now: NOW, tz: TZ });
  assert.match(m.block, /Node\.js LTS/);
});
test('a day with nothing stored says so instead of staying silent', () => {
  const m = retrieveMemory(seeded(), { query: 'What did I ask you on 5 November?', now: NOW, tz: TZ });
  assert.match(m.block, /No stored conversation from/);
  assert.equal(m.turns.length, 0); // and does NOT fall back to unrelated recent turns
});
test('topical recall without any date', () => {
  const m = retrieveMemory(seeded(), { query: 'remind me what you said about Supabase', now: NOW, tz: TZ });
  assert.match(m.block, /Supabase/);
});
test('unrelated question gets no memory block; empty store with a date ref warns', () => {
  assert.equal(retrieveMemory(seeded(), { query: 'Explain how TCP slow start works', now: NOW, tz: TZ }).block, '');
  const m = retrieveMemory(new MemoryStore(), { query: 'What did I ask you on Monday?', now: NOW, tz: TZ });
  assert.match(m.block, /Nothing is stored/);
});
test('current conversation is excluded (already in message history)', () => {
  const s = seeded();
  const id = s.all().find((t) => /CRM/.test(t.user))!.conversationId;
  const m = retrieveMemory(s, { query: 'CRM pricing for HubSpot', now: NOW, tz: TZ, excludeConversationId: id });
  assert.doesNotMatch(m.block, /· turn /);
});
