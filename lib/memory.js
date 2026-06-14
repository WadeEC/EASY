// Long-term memory — bolts onto the existing league.db database. Two tables:
//   facts: things the AI remembers (key/value, scoped to user|league|session)
//   facts_fts: FTS5 index so 'recall' can do fuzzy lookup
//
// We piggyback on getDb() from lib/db.js so we share the same connection and
// don't have to manage a second file.

import { getDb } from "./db.js";

let initDone = false;
function ensure() {
  if (initDone) return;
  initDone = true;
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS ai_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'league',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_facts_key ON ai_facts(key);

    CREATE VIRTUAL TABLE IF NOT EXISTS ai_facts_fts USING fts5(
      key, value, content='ai_facts', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS ai_facts_ai AFTER INSERT ON ai_facts BEGIN
      INSERT INTO ai_facts_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS ai_facts_ad AFTER DELETE ON ai_facts BEGIN
      INSERT INTO ai_facts_fts(ai_facts_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
    END;
    CREATE TRIGGER IF NOT EXISTS ai_facts_au AFTER UPDATE ON ai_facts BEGIN
      INSERT INTO ai_facts_fts(ai_facts_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
      INSERT INTO ai_facts_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;
  `);
}

export function remember(key, value, scope = "league") {
  ensure();
  const d = getDb();
  // Upsert by key: most recent wins on direct recall
  d.prepare(`INSERT INTO ai_facts (key, value, scope, created_at) VALUES (?, ?, ?, ?)`)
    .run(key, String(value), scope, Date.now());
  return { ok: true, key };
}

export function recall(query, limit = 5) {
  ensure();
  const d = getDb();
  const exact = d.prepare(
    `SELECT key, value, scope, created_at FROM ai_facts WHERE key = ? ORDER BY id DESC LIMIT ?`
  ).all(query, limit);
  if (exact.length) return exact;
  try {
    // Sanitize query for FTS5 (strip punctuation that breaks the parser)
    const q = String(query).replace(/[^\w\s]/g, " ").trim();
    if (!q) return [];
    const fts = d.prepare(
      `SELECT f.key, f.value, f.scope, f.created_at
       FROM ai_facts_fts JOIN ai_facts f ON f.id = ai_facts_fts.rowid
       WHERE ai_facts_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(q, limit);
    return fts;
  } catch {
    return [];
  }
}

export function listFacts(limit = 50) {
  ensure();
  return getDb().prepare(`SELECT id, key, value, scope, created_at FROM ai_facts ORDER BY id DESC LIMIT ?`).all(limit);
}

export function forget(id) {
  ensure();
  getDb().prepare(`DELETE FROM ai_facts WHERE id = ?`).run(id);
  return { ok: true };
}

// ---------------------------------------------------------------- league-wide settings
// Thin wrapper on top of ai_facts so non-AI code can stash a single value by key
// without writing a new table. Use this for things like the currently active
// check-in week (shared between Team Board and Kiosk).
export function getSetting(key, fallback = null) {
  ensure();
  const row = getDb().prepare(`SELECT value FROM ai_facts WHERE key = ? ORDER BY id DESC LIMIT 1`).get(`setting:${key}`);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  ensure();
  const d = getDb();
  // Keep one row per setting key — delete any prior values so getSetting always
  // returns the latest without leaving a long tail of history rows.
  d.prepare(`DELETE FROM ai_facts WHERE key = ?`).run(`setting:${key}`);
  if (value == null || value === "") return { ok: true, key, cleared: true };
  d.prepare(`INSERT INTO ai_facts (key, value, scope, created_at) VALUES (?, ?, ?, ?)`)
    .run(`setting:${key}`, String(value), "league", Date.now());
  return { ok: true, key, value: String(value) };
}

export function clearScope(scope) {
  ensure();
  const r = getDb().prepare(`DELETE FROM ai_facts WHERE scope = ?`).run(scope);
  return { deleted: r.changes };
}
