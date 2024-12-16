import { DatabaseSync } from 'node:sqlite';
import { TERMINAL_STATUSES } from '@hashbridge/core/types';
import type { SwapRecord, SwapRepo } from './types';

export function openSwapRepo(path: string): SwapRepo {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS swaps (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const insertStmt = db.prepare('INSERT INTO swaps (id, hash, status, data, updated_at) VALUES (?, ?, ?, ?, ?)');
  const getStmt = db.prepare('SELECT data FROM swaps WHERE id = ?');
  const byHashStmt = db.prepare('SELECT data FROM swaps WHERE hash = ?');
  const updateStmt = db.prepare('UPDATE swaps SET status = ?, data = ?, updated_at = ? WHERE id = ?');
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
  const activeStmt = db.prepare(`SELECT data FROM swaps WHERE status NOT IN (${placeholders}) ORDER BY rowid`);

  const parse = (row: unknown): SwapRecord | undefined =>
    row ? (JSON.parse((row as { data: string }).data) as SwapRecord) : undefined;

  const get = (swapId: string) => parse(getStmt.get(swapId));

  return {
    insert(swap) {
      insertStmt.run(swap.swapId, swap.hash, swap.status, JSON.stringify(swap), Date.now());
    },
    get,
    findByHash(hash) {
      return parse(byHashStmt.get(hash));
    },
    update(swapId, patch) {
      const current = get(swapId);
      if (!current) throw new Error(`swap ${swapId} not found`);
      const next: SwapRecord = { ...current, ...patch, swapId: current.swapId };
      updateStmt.run(next.status, JSON.stringify(next), Date.now(), swapId);
      return next;
    },
    listActive() {
      return activeStmt.all(...TERMINAL_STATUSES).map((row) => parse(row)!);
    },
  };
}
