// Token usage + cost tracking — piggybacks on the existing league.db.
// Surfaced through /api/costs so you can see how close you are to your
// monthly budget at a glance.

import { getDb } from "./db.js";

let initDone = false;
function ensure() {
  if (initDone) return;
  initDone = true;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage_log(ts);
  `);
}

export function logUsage(u) {
  ensure();
  try {
    getDb().prepare(
      `INSERT INTO ai_usage_log (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(Date.now(), u.provider, u.model || "?",
      u.input_tokens || 0, u.output_tokens || 0,
      u.cache_read_tokens || 0, u.cache_write_tokens || 0,
      u.cost_usd || 0);
  } catch (e) {
    console.warn("[usage] log failed:", e.message);
  }
}

export function getUsage({ days = 30 } = {}) {
  ensure();
  const since = Date.now() - days * 86_400_000;
  const rows = getDb().prepare(
    `SELECT provider, model,
            COUNT(*)                 AS calls,
            SUM(input_tokens)        AS input_tokens,
            SUM(output_tokens)       AS output_tokens,
            SUM(cache_read_tokens)   AS cache_read_tokens,
            SUM(cache_write_tokens)  AS cache_write_tokens,
            ROUND(SUM(cost_usd), 4)  AS cost_usd
     FROM ai_usage_log
     WHERE ts >= ?
     GROUP BY provider, model
     ORDER BY cost_usd DESC`
  ).all(since);
  const total = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  // Project month-end based on prorated days
  const dayMs = 86_400_000;
  const oldest = getDb().prepare(`SELECT MIN(ts) m FROM ai_usage_log WHERE ts >= ?`).get(since)?.m || Date.now();
  const elapsedDays = Math.max((Date.now() - oldest) / dayMs, 0.25);
  const projectedMonth = (total / elapsedDays) * 30;
  // Cache hit rate
  const cacheStats = getDb().prepare(
    `SELECT SUM(cache_read_tokens) r, SUM(cache_write_tokens) w, SUM(input_tokens) i FROM ai_usage_log WHERE ts >= ?`
  ).get(since);
  const cacheable = (cacheStats.r || 0) + (cacheStats.w || 0) + (cacheStats.i || 0);
  const hitRate = cacheable ? (cacheStats.r || 0) / cacheable : 0;
  return {
    window_days: days,
    total_cost_usd: Number(total.toFixed(4)),
    projected_30d_cost_usd: Number(projectedMonth.toFixed(2)),
    cache_hit_rate: Number(hitRate.toFixed(3)),
    by_model: rows,
  };
}

export function recentCalls(limit = 20) {
  ensure();
  return getDb().prepare(
    `SELECT ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
     FROM ai_usage_log ORDER BY id DESC LIMIT ?`
  ).all(limit);
}
