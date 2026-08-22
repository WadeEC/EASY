// The database spine — one SQLite file, same flexible model as before:
// record_types, fields (the schema-as-data), records (+ JSON blob), rules, staging, audit_log.
//
// SEASONS ARE FIRST CLASS (v2). Every row that belongs to a season carries a
// real `season` COLUMN — not a value buried in a JSON blob. That means:
//   * the database can index and enforce season separation,
//   * every read is scoped in SQL instead of by hand in each route,
//   * "show me Fall 2026" can never accidentally include Fall 2023 rows.
// See lib/season-scope.js for the request-level guard and lib/seasons.js for
// the season registry itself.
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

-- The season registry. One row per season the organization has ever run.
-- 'locked' makes a season read-only: a finished season stays exactly as it was
-- finished, so a stray AI call or a mis-click cannot rewrite last year.
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'archived'
  locked INTEGER NOT NULL DEFAULT 0,       -- 1 = read-only
  starts_on TEXT,
  ends_on TEXT,
  sort INTEGER DEFAULT 0,
  created_at TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status);

-- One row per migration so boot-time upgrades never run twice.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT,
  note TEXT
);
`;

// Record types that belong to exactly one season. Anything not listed here
// (record_types, fields, rules, users…) is organization-wide configuration and
// is deliberately shared across seasons.
export const SEASON_OWNED_TYPES = [
  "player", "coach", "referee", "team", "game", "division", "attendance", "tournament",
];

let _db = null;
export function getDb() {
  if (!_db) {
    const file = process.env.LEAGUE_DB || path.join(process.cwd(), "league.db");
    _db = new Database(file);
    _db.pragma("journal_mode = WAL");
    _db.exec(SCHEMA);
    runMigrations(_db);
  }
  return _db;
}

export const now = () => new Date().toISOString().slice(0, 19);

// ---------------------------------------------------------------- migrations
// Each entry runs at most once, tracked in schema_migrations. Every one is
// written to be safe on a fresh install AND on an existing league.db.
function migrated(d, name) {
  return !!d.prepare("SELECT 1 FROM schema_migrations WHERE name=?").get(name);
}
function markMigrated(d, name, note = "") {
  d.prepare("INSERT OR REPLACE INTO schema_migrations(name, applied_at, note) VALUES(?,?,?)")
    .run(name, now(), note);
}
export function hasColumn(d, table, col) {
  try { return d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
  catch { return false; }
}
function addColumn(d, table, col, decl) {
  if (hasColumn(d, table, col)) return false;
  try { d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); return true; } catch { return false; }
}

function runMigrations(d) {
  // ---- legacy one-off column adds (kept from v1; harmless to re-run) -------
  addColumn(d, "users", "password_reset_requested", "INTEGER DEFAULT 0");
  addColumn(d, "users", "must_change_password", "INTEGER DEFAULT 0");

  // ---- 001: real season columns -------------------------------------------
  if (!migrated(d, "001_season_columns")) {
    addColumn(d, "records", "season", "TEXT");
    addColumn(d, "import_master", "season", "TEXT");
    addColumn(d, "player_links", "season", "TEXT");
    addColumn(d, "schedule_blackouts", "season", "TEXT");
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_records_type_season ON records(type, season);
      CREATE INDEX IF NOT EXISTS idx_records_season      ON records(season);
      CREATE INDEX IF NOT EXISTS idx_master_season       ON import_master(season);
      CREATE INDEX IF NOT EXISTS idx_links_season        ON player_links(season);
    `);
    markMigrated(d, "001_season_columns", "season column on records/import_master/player_links/schedule_blackouts");
  }

  // ---- 002: blackouts unique per (date, league, SEASON) --------------------
  // The old UNIQUE(date, league) meant blocking Oct 4 in Saturday Limerick for
  // Fall 2026 collided with the Fall 2023 blackout on the same date.
  if (!migrated(d, "002_blackouts_season_unique")) {
    const hasSeason = hasColumn(d, "schedule_blackouts", "season");
    const tx = d.transaction(() => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS schedule_blackouts_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          league TEXT,
          season TEXT,
          reason TEXT,
          created_at TEXT,
          created_by TEXT,
          UNIQUE(date, league, season)
        )`);
      d.exec(`
        INSERT OR IGNORE INTO schedule_blackouts_v2(id, date, league, season, reason, created_at, created_by)
        SELECT id, date, league, ${hasSeason ? "season" : "NULL"}, reason, created_at, created_by
        FROM schedule_blackouts`);
      d.exec("DROP TABLE schedule_blackouts");
      d.exec("ALTER TABLE schedule_blackouts_v2 RENAME TO schedule_blackouts");
      d.exec("CREATE INDEX IF NOT EXISTS idx_blackouts_date ON schedule_blackouts(date)");
      d.exec("CREATE INDEX IF NOT EXISTS idx_blackouts_season ON schedule_blackouts(season)");
    });
    tx();
    markMigrated(d, "002_blackouts_season_unique", "UNIQUE(date, league, season)");
  }

  // ---- 003: league locks are per season ------------------------------------
  // A locked roster in Fall 2023 must not lock the same league in Fall 2026.
  if (!migrated(d, "003_league_locks_per_season")) {
    const tx = d.transaction(() => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS league_locks_v2 (
          season TEXT NOT NULL DEFAULT '',
          league TEXT NOT NULL,
          locked INTEGER DEFAULT 0,
          locked_at TEXT,
          locked_by TEXT,
          PRIMARY KEY (season, league)
        )`);
      d.exec(`
        INSERT OR IGNORE INTO league_locks_v2(season, league, locked, locked_at, locked_by)
        SELECT '', league, locked, locked_at, locked_by FROM league_locks`);
      d.exec("DROP TABLE league_locks");
      d.exec("ALTER TABLE league_locks_v2 RENAME TO league_locks");
    });
    tx();
    markMigrated(d, "003_league_locks_per_season", "PRIMARY KEY(season, league)");
  }

  // ---- 004: backfill the season column from the JSON blob ------------------
  // Nothing is invented: a record with no season in its JSON keeps a NULL
  // season and lands in the "(no season)" bucket until someone assigns it.
  if (!migrated(d, "004_backfill_record_season")) {
    d.exec(`
      UPDATE records
         SET season = json_extract(data, '$.season')
       WHERE season IS NULL
         AND json_valid(data)
         AND json_extract(data, '$.season') IS NOT NULL
         AND TRIM(COALESCE(json_extract(data, '$.season'), '')) <> ''`);
    const n = d.prepare("SELECT COUNT(*) c FROM records WHERE season IS NOT NULL").get().c;
    markMigrated(d, "004_backfill_record_season", `${n} records carried a season`);
  }

  // ---- 005: seed the season registry from what already exists --------------
  if (!migrated(d, "005_seed_season_registry")) {
    const names = new Set();
    for (const r of d.prepare("SELECT DISTINCT season FROM records WHERE season IS NOT NULL AND TRIM(season)<>''").all())
      names.add(String(r.season));
    try {
      const f = d.prepare("SELECT options FROM fields WHERE record_type='player' AND name='season'").get();
      if (f && f.options) for (const o of JSON.parse(f.options)) if (String(o).trim()) names.add(String(o).trim());
    } catch {}
    const ins = d.prepare(
      "INSERT OR IGNORE INTO seasons(name, status, locked, sort, created_at, created_by) VALUES(?,?,?,?,?,?)");
    let i = 0;
    for (const n of [...names].sort()) ins.run(n, "active", 0, i++, now(), "migration");
    markMigrated(d, "005_seed_season_registry", `${names.size} seasons registered`);
  }

  // ---- 006: adopt orphan records into the one season that has data ---------
  // Runs ONLY when the situation is unambiguous: exactly one season carries
  // player records. Otherwise rows are left alone and show up in the "needs a
  // season" cleanup report — guessing is exactly the quiet wrong answer we are
  // trying to remove.
  if (!migrated(d, "006_adopt_orphans_single_season")) {
    const withPlayers = d.prepare(
      `SELECT season, COUNT(*) c FROM records
        WHERE type='player' AND season IS NOT NULL AND TRIM(season)<>'' GROUP BY season`).all();
    let note = `skipped — ${withPlayers.length} seasons have players`;
    if (withPlayers.length === 1) {
      const target = withPlayers[0].season;
      const ph = SEASON_OWNED_TYPES.map(() => "?").join(",");
      const res = d.prepare(
        `UPDATE records SET season=? WHERE (season IS NULL OR TRIM(season)='') AND type IN (${ph})`
      ).run(target, ...SEASON_OWNED_TYPES);
      d.prepare("UPDATE import_master SET season=? WHERE season IS NULL").run(target);
      d.prepare("UPDATE league_locks SET season=? WHERE season=''").run(target);
      d.prepare("UPDATE schedule_blackouts SET season=? WHERE season IS NULL").run(target);
      d.prepare("UPDATE player_links SET season=? WHERE season IS NULL").run(target);
      note = `adopted ${res.changes} orphan records into "${target}"`;
    }
    markMigrated(d, "006_adopt_orphans_single_season", note);
  }

  // ---- 007: keep the JSON blob in step with the season column --------------
  // Existing UI code reads d.season out of the blob; the column is now the
  // source of truth, so make the blob agree.
  if (!migrated(d, "007_sync_season_into_blob")) {
    const res = d.prepare(
      `UPDATE records SET data = json_set(data, '$.season', season)
        WHERE season IS NOT NULL AND TRIM(season)<>'' AND json_valid(data)
          AND COALESCE(json_extract(data,'$.season'),'') <> season`).run();
    markMigrated(d, "007_sync_season_into_blob", `${res.changes} blobs synced`);
  }

  // ---- 008: make sure an active season is set ------------------------------
  if (!migrated(d, "008_active_season_setting")) {
    if (!safeSetting(d, "active_season")) {
      const first = d.prepare("SELECT name FROM seasons ORDER BY sort DESC, id DESC LIMIT 1").get();
      if (first) writeSetting(d, "active_season", first.name);
    }
    markMigrated(d, "008_active_season_setting", "");
  }
}

// Settings live in ai_facts (see lib/memory.js). Migrations can run before that
// module has initialised, so read/write defensively here.
function safeSetting(d, key) {
  try {
    const row = d.prepare("SELECT value FROM ai_facts WHERE key=? ORDER BY id DESC LIMIT 1").get(`setting:${key}`);
    return row ? row.value : null;
  } catch { return null; }
}
function writeSetting(d, key, value) {
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS ai_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'league', created_at INTEGER NOT NULL)`);
    d.prepare("DELETE FROM ai_facts WHERE key=?").run(`setting:${key}`);
    d.prepare("INSERT INTO ai_facts(key, value, scope, created_at) VALUES(?,?,?,?)")
      .run(`setting:${key}`, String(value), "league", Date.now());
  } catch {}
}

export function migrationLog() {
  return getDb().prepare("SELECT * FROM schema_migrations ORDER BY applied_at, name").all();
}

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
    // Only restore columns the table actually has — a snapshot taken before the
    // migration that added `season` would otherwise blow up on UPDATE.
    const cols = Object.keys(before).filter((k) => hasColumn(d, table, k));
    if (!cols.length) return { error: "snapshot has no restorable columns" };
    const set = cols.map((k) => `${k}=?`).join(",");
    d.prepare(`UPDATE ${table} SET ${set} WHERE id=?`).run(...cols.map((k) => before[k]), tid);
  } else if (action === "delete" && before) {
    const cols = Object.keys(before).filter((k) => hasColumn(d, table, k));
    const ph = cols.map(() => "?").join(",");
    d.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${ph})`).run(...cols.map((k) => before[k]));
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
