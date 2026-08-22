// Stable, public-friendly results feed for the league website.
// Record of who beat whom — NOT computed standings (per client direction).
//
// GET /api/results              → JSON (all leagues)
// GET /api/results?league=X     → JSON filtered by league
// GET /api/results?format=csv   → CSV
// GET /api/results?format=html  → HTML table
//
// POST is also supported for symmetry with other internal routes (same body shape: { league, format }).

import { getSchedule } from "@/lib/tools.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

function winnerLabel(g) {
  if (!g.winner) return "";
  if (g.winner === "home") return g.home;
  if (g.winner === "away") return g.away;
  if (g.winner === "tie") return "Tie";
  if (g.winner === "forfeit_home") return `${g.away} (forfeit)`;
  if (g.winner === "forfeit_away") return `${g.home} (forfeit)`;
  return g.winner;
}
function forfeitLabel(g) {
  if (g.winner === "forfeit_home") return g.home;
  if (g.winner === "forfeit_away") return g.away;
  return "";
}
function scoredOnly(games) { return (games || []).filter((g) => g.winner); }

function asCsv(games) {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const head = ["Date", "Time", "League", "Home", "Home Score", "Away", "Away Score", "Winner", "Forfeit", "Note"].join(",");
  const rows = scoredOnly(games).map((g) => [
    g.date, g.time || "", g.league || "", g.home, g.home_score ?? "", g.away, g.away_score ?? "",
    winnerLabel(g), forfeitLabel(g), g.score_note || "",
  ].map(esc).join(","));
  return [head, ...rows].join("\r\n");
}

function asHtml(games) {
  const e = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = scoredOnly(games).map((g) => "    <tr><td>" + e(g.date) + "</td><td>" + e(g.time || "") + "</td><td>" + e(g.league || "") + "</td><td>" + e(g.home) + "</td><td>" + e(g.home_score ?? "") + "</td><td>" + e(g.away) + "</td><td>" + e(g.away_score ?? "") + "</td><td>" + e(winnerLabel(g)) + "</td></tr>").join("\n");
  return '<table class="ff-results">\n  <thead><tr><th>Date</th><th>Time</th><th>League</th><th>Home</th><th>Score</th><th>Away</th><th>Score</th><th>Winner</th></tr></thead>\n  <tbody>\n' + rows + "\n  </tbody>\n</table>";
}

function asJson(games) {
  return scoredOnly(games).map((g) => ({
    id: g.id, date: g.date, time: g.time || "", league: g.league || "",
    home: g.home, home_score: g.home_score, away: g.away, away_score: g.away_score,
    winner: g.winner, forfeit: forfeitLabel(g) || null, note: g.score_note || "",
    score_at: g.score_at || "",
  }));
}

function pickFormat(req, override) {
  const u = new URL(req.url);
  return (override || u.searchParams.get("format") || "json").toLowerCase();
}
function pickLeague(req, override) {
  const u = new URL(req.url);
  return override || u.searchParams.get("league") || null;
}

function respond(games, format) {
  if (format === "csv") {
    return new Response(asCsv(games), { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (format === "html") {
    return new Response(asHtml(games), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return new Response(JSON.stringify({ results: asJson(games) }, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET(req) {
  bindRequest(req);
  const league = pickLeague(req);
  const format = pickFormat(req);
  const games = getSchedule(league);
  return respond(games, format);
}

export async function POST(req) {
  bindRequest(req);
  let b = {};
  try { b = await req.json(); } catch {}
  const league = pickLeague(req, b.league);
  const format = pickFormat(req, b.format);
  const games = getSchedule(league);
  return respond(games, format);
}
