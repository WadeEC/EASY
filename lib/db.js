// The database spine — one SQLite file, same flexible model as before:
// record_types, fields (the schema-as-data), records (+ JSON blob), rules, staging, audit_log.
import Database from "better-sqlite3";
import path from "path";
import { getActor } from "./actor.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL, label TEXT, description TEXT, added_by TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT NOT NULL, name TEXT NOT NULL, label TEXT,
  data_type TEXT NOT NULL, options TEXT, required INTEGER DEFAULT 0, sort INTEGER DEFAULT 0,
  added_by TEXT, created_at TEXT, UNIQUE(record_type, name)
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, name TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, kind TEXT DEFAULT 'reactive', record_type TEXT, hard INTEGER DEFAULT 0,
  condition TEXT, action TEXT, active INTEGER DEFAULT 1, added_by TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS staging (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, op TEXT, payload TEXT, reason TEXT, added_by TEXT DEFAULT 'ai',
  status TEXT DEFAULT 'pending', created_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, action TEXT, target_table TEXT, target_id INTEGER,
  before TEXT, after TEXT, reason TEXT, created_at TEXT, undone INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS league_locks (
  league TEXT PRIMARY KEY,
  locked INTEGER DEFAULT 0,
  locked_at TEXT,
  locked_by TEXT
);
CREATE TABLE IF NOT EXISTS player_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  player_id INTEGER,
  coach_id INTEGER,
  reason TEXT,
  created_at TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_player_links_link ON player_links(link_id);
CREATE INDEX IF NOT EXISTS idx_player_links_player ON player_links(player_id);
CREATE INDEX IF NOT EXISTS idx_player_links_coach ON player_links(coach_id);
CREATE TABLE IF NOT EXISTS schedule_blackouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  league TEXT,
  reason TEXT,
  created_at TEXT,
  created_by TEXT,
  UNIQUE(date, league)
);
CREATE INDEX IF NOT EXISTS idx_blackouts_date ON schedule_blackouts(date);
CREATE TABLE IF NOT EXISTS import_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT NOT NULL,
  source_file TEXT,
  source_district TEXT,
  source_league TEXT,
  identity_key TEXT,
  status TEXT,            -- "added" | "recognized" | "ambiguous_added"
  player_id INTEGER,      -- if added or recognized, the matching record id
  raw_data TEXT NOT NULL, -- JSON of the row's full original columns
  imported_at TEXT,
  imported_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_master_record_type ON import_master(record_type);
CREATE INDEX IF NOT EXISTS idx_master_imported_at ON import_master(imported_at);
CREATE INDEX IF NOT EXISTS idx_master_district ON import_master(source_district);

-- Authentication. pass_hash stores pbkdf2$iter$saltHex$hashHex so we never
-- keep plaintext. role is "admin" (full) or "user" (limited). disabled_at
-- lets an admin de-activate an account without losing audit history.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT,
  last_login_at TEXT,
  disabled_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  expires_at TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

let _db = null;
export function getDb() {
  if (!_db) {
    const file = process.env.LEAGUE_DB || path.join(process.cwd(), "league.db");
    _db = new Database(file);
    _db.pragma("journal_mode = WAL");
    _db.exec(SCHEMA);
  }
  return _db;
}

export const now = () => new Date().toISOString().slice(0, 19);

export function getRow(table, id) {
  return getDb().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) || null;
}

export function logAudit(actor, action, table, targetId, before, after, reason = "") {
  // Generic UI changes are recorded as "user"; tag them to the admin account in play.
  if (actor == null || actor === "user") actor = getActor();
  const info = getDb().prepare(
    `INSERT INTO audit_log(actor,action,target_table,target_id,before,after,reason,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(actor, action, table, targetId,
    before != null ? JSON.stringify(before) : null,
    after != null ? JSON.stringify(after) : null, reason, now());
  return info.lastInsertRowid;
}

export function listAudit(limit = 200) {
  return getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}

export function undo(auditId) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM audit_log WHERE id=? AND undone=0").get(auditId);
  if (!row) return { error: "nothing to undo" };
  const before = row.before ? JSON.parse(row.before) : null;
  const { target_table: table, target_id: tid, action } = row;
  if (action === "create") {
    d.prepare(`DELETE FROM ${table} WHERE id=?`).run(tid);
  } else if (action === "update" && before) {
    const cols = Object.keys(before).map((k) => `${k}=?`).join(",");
    d.prepare(`UPDATE ${table} SET ${cols} WHERE id=?`).run(...Object.values(before), tid);
  } else if (action === "delete" && before) {
    const cols = Object.keys(before).join(",");
    const ph = Object.keys(before).map(() => "?").join(",");
    d.prepare(`INSERT INTO ${table}(${cols}) VALUES(${ph})`).run(...Object.values(before));
  } else {
    return { error: `cannot undo action '${action}'` };
  }
  d.prepare("UPDATE audit_log SET undone=1 WHERE id=?").run(auditId);
  return { status: "undone", audit_id: auditId };
}

// Rewind the system to a point in time: undo every *data* change made after `afterId`,
// newest first. Schema changes (fields, record types, rules) are left untouched so the
// app can't break. Returns how many were reverted.
export function restoreToPoint(afterId) {
  const d = getDb();
  const rows = d.prepare(
    `SELECT id FROM audit_log
     WHERE id > ? AND undone = 0 AND target_table = 'records' AND action IN ('create','update','delete')
     ORDER BY id DESC`
  ).all(Number(afterId));
  let undone = 0, failed = 0;
  for (const r of rows) { const res = undo(r.id); if (res && res.status === "undone") undone++; else failed++; }
  return { status: "restored", undone, failed, point: Number(afterId) };
}
