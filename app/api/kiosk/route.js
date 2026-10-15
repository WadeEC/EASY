import { getRecords, divisionOf,} from "@/lib/tools.js";
import { seasonFromReq, inSeason } from "@/lib/seasons.js";
import { bindRequest } from "@/lib/actor.js";
import { gamesForWeek, jerseyFor } from "@/lib/game-day.js";

export const dynamic = "force-dynamic";
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const digits = (s) => String(s || "").replace(/\D+/g, "");
const lastTok = (n) => (String(n || "").trim().split(/\s+/).pop() || "");

// Build a player's "what do I need to know" card: team, field, coach, jersey.
// Field and jersey come from the team's game for the check-in week (see
// lib/game-day.js) — not the season opener — so week 4's away game says DARK.
function details(p, coaches, games, week) {
  const team = p.team || "";
  const co = team
    ? coaches.filter((c) => (c.team || "") === team).map((c) => ({ name: c.name, role: c.role || "" }))
    : [];
  // One card per game this week — two games in a day means two cards, each
  // with its own jersey (home in one, away in the other is possible).
  const week_games = gamesForWeek(games, team, week).map((g) => {
    const isHome = g.home_team === team;
    return {
      week: g.week, date: g.date || "", time: g.time || "",
      vs: (isHome ? g.away_team : g.home_team) || "",
      location: g.location || "",
      home_away: isHome ? "home" : "away",
      jersey: jerseyFor(g, team),
    };
  });
  // The big Field / Jersey boxes show the FIRST game of the week.
  const next = week_games[0] || null;
  const field = next ? next.location : "";
  const jerseyColor = next ? next.jersey : "";
  // Leave field empty when no game is scheduled — the kiosk renders "TBD" in
  // that case. Falling back to the league name (e.g. "Sunday Upper Merion")
  // misled players into thinking that was their field.
  return {
    id: p.id, name: p.name, age: p.age ?? "", division: divisionOf(p), league: p.league || "",
    team, coaches: co, field, next, week_games,
    jersey_size: p.jersey_size || "",
    jersey_color: jerseyColor,
    size_confirmed_at: p.size_confirmed_at || "",
    size_confirmed_by: p.size_confirmed_by || "",
  };
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  const season = seasonFromReq(req); // sidebar season picker
  const method = b.method || "name";
  const q = String(b.query || "").trim();

  // Each kiosk device sends the league/division it's set to (blank = everyone),
  // so two kiosks at two fields can each show only their own players.
  const kf = { league: String(b.league || ""), division: String(b.division || "") };
  const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => ({ id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data) }))
    .filter((p) => (!kf.league || (p.league || "") === kf.league) && (!kf.division || divisionOf(p) === kf.division));
  const coaches = getRecords("coach").map((r) => { const d = parse(r.data); return { name: r.name || d.full_name || `#${r.id}`, role: d.role || "", team: d.team || "" }; });
  const games = getRecords("game").map((r) => parse(r.data));

  const dq = digits(q);
  const isText = /[a-z]/i.test(q);
  const byName = () => { const ql = q.toLowerCase(); return ql.length >= 2 ? all.filter((p) => String(p.name).toLowerCase().includes(ql)) : []; };
  const byId = () => all.filter((p) => p.id === Number(dq) || [p.keytag, p.key_tag, p.badge, p.jersey_number, p.number].some((v) => String(v ?? "") === q));
  const byPhone = () => (dq.length >= 3 ? all.filter((p) => digits(p.parent_phone || p.phone).slice(-4) === dq.slice(-4)) : []);

  let matched = [];
  if (method === "phone") matched = byPhone();
  else if (method === "id") matched = byId();
  else if (method === "name") matched = byName();
  else { // auto: one intake — letters → name; digits → key tag/ID or last-4 of phone
    if (isText) matched = byName();
    else if (dq) { const seen = new Set(); matched = [...byId(), ...byPhone()].filter((p) => !seen.has(p.id) && seen.add(p.id)); }
  }

  // Group siblings: household = shared parent phone, else shared last name.
  const hh = (p) => digits(p.parent_phone || p.phone) || ("ln:" + lastTok(p.name).toLowerCase());
  matched.sort((a, c) => hh(a).localeCompare(hh(c)) || String(a.name).localeCompare(String(c.name)));
  const groups = [];
  for (const p of matched) {
    const key = hh(p);
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label: lastTok(p.name) ? `${lastTok(p.name)} family` : "Players", players: [] }; groups.push(g); }
    g.players.push(details(p, coaches, games, String(b.week || "")));
  }
  return Response.json({ count: matched.length, groups });
}
