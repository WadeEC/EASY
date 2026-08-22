import { getRecords, divisionOf,} from "@/lib/tools.js";
import { seasonFromReq, inSeason } from "@/lib/seasons.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const digits = (s) => String(s || "").replace(/\D+/g, "");
const lastTok = (n) => (String(n || "").trim().split(/\s+/).pop() || "");

// Build a player's "what do I need to know" card: team, field, coach.
// Jersey color convention (FR-3.7): home team wears LIGHT, away team wears DARK.
function details(p, coaches, games) {
  const team = p.team || "";
  const co = team
    ? coaches.filter((c) => (c.team || "") === team).map((c) => ({ name: c.name, role: c.role || "" }))
    : [];
  let field = "", next = null, jerseyColor = "";
  if (team) {
    const tg = games.filter((g) => g.home_team === team || g.away_team === team)
      .sort((a, b) => (Number(a.week) || 0) - (Number(b.week) || 0));
    if (tg.length) {
      const g = tg[0];
      const isHome = g.home_team === team;
      jerseyColor = isHome ? "light" : "dark";
      field = g.location || "";
      next = {
        week: g.week, date: g.date || "", time: g.time || "",
        vs: (isHome ? g.away_team : g.home_team) || "",
        location: g.location || "",
        home_away: isHome ? "home" : "away",
        jersey: jerseyColor,
      };
    }
  }
  // Leave field empty when no game is scheduled — the kiosk renders "TBD" in
  // that case. Falling back to the league name (e.g. "Sunday Upper Merion")
  // misled players into thinking that was their field.
  return {
    id: p.id, name: p.name, age: p.age ?? "", division: divisionOf(p), league: p.league || "",
    team, coaches: co, field, next,
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

  const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => ({ id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data) }));
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
    g.players.push(details(p, coaches, games));
  }
  return Response.json({ count: matched.length, groups });
}
