import { join } from 'node:path';
import { config } from './config.js';
import { sampleTurns } from './sample.js';
import { MemoryStore } from './memory/store.js';

const store = new MemoryStore(join(config.dataDir, 'memory.jsonl'));
const have = new Set(store.all().map((t) => t.conversationId));
let added = 0;
for (const t of sampleTurns(new Date(), config.defaultTz)) {
  if (have.has(t.conversationId)) continue;
  store.add(t);
  added++;
}
console.log(`Seeded ${added} sample turn(s) into ${join(config.dataDir, 'memory.jsonl')}`);
