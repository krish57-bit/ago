import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TurnRecord } from '../types.js';

/**
 * Append-only JSONL log of turns, mirrored in memory.
 * Chosen over SQLite so `npm install` never needs a native build; the log is
 * the source of truth and is trivially greppable. Swap point: this class.
 */
export class MemoryStore {
  private turns: TurnRecord[] = [];

  constructor(private file?: string) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            this.turns.push(JSON.parse(line) as TurnRecord);
          } catch {
            /* a torn last line must not brick startup */
          }
        }
        this.turns.sort((a, b) => a.ts.localeCompare(b.ts));
      }
    }
  }

  all(): readonly TurnRecord[] {
    return this.turns;
  }

  add(turn: TurnRecord): void {
    this.turns.push(turn);
    this.turns.sort((a, b) => a.ts.localeCompare(b.ts));
    if (this.file) appendFileSync(this.file, JSON.stringify(turn) + '\n');
  }

  /** "Forget this": the user controls what is remembered. Rewrites the log without the turn. */
  remove(id: string): boolean {
    const before = this.turns.length;
    this.turns = this.turns.filter((t) => t.id !== id);
    if (this.turns.length === before) return false;
    this.persist();
    return true;
  }

  /** Delete a whole conversation. Returns how many turns were removed. */
  removeConversation(conversationId: string): number {
    const keep = this.turns.filter((t) => t.conversationId !== conversationId);
    const removed = this.turns.length - keep.length;
    if (removed === 0) return 0;
    this.turns = keep;
    this.persist();
    return removed;
  }

  private persist(): void {
    if (this.file) writeFileSync(this.file, this.turns.map((t) => JSON.stringify(t)).join('\n') + (this.turns.length ? '\n' : ''));
  }

  conversation(id: string): TurnRecord[] {
    return this.turns.filter((t) => t.conversationId === id);
  }
}
