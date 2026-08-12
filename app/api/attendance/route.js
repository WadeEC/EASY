import { getRecords, getFields, seedAttendance, getCheckins, setCheckin, updateRecord } from "@/lib/tools.js";
import { getRow, now, logAudit } from "@/lib/db.js";
import { getActor, setActorFromReq } from "@/lib/actor.js";
import { seasonFromReq, inSeason } from "@/lib/seasons.js";
import { emit } from "@/lib/event-bus.js";

export const dynamic = "force-dynamic";
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
// the Sunday that starts a date's week (attendance keys use this)
function weekStartISO(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return "";
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

export async function POST(req) {
  const b = await req.json();
  const season = seasonFromReq(req); // sidebar season picker

  if (b.action === "list") {
    seedAttendance();
    const checked = getCheckins(b.week);
    const fields = getFields("player").map((f) => ({ name: f.name, label: f.label, data_type: f.data_type, required: !!f.required, options: f.options }));
    const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => { const d = parse(r.data); return { id: r.id, name: r.name || d.full_name || `#${r.id}`, league: d.league || "", division: d.division || "", team: d.team || "", present: checked.has(r.id), data: d }; });
    const leagues = [...new Set(all.map((p) => p.league).filter(Boolean))];
    const divisions = [...new Set(all.map((p) => p.division).filter(Boolean))];
    const teams = [...new Set(all.map((p) => p.team).filter(Boolean))];
    const coachesByTeam = {};
    for (const r of getRecords("coach")) { const d = parse(r.data); const t = d.team || ""; if (t) (coachesByTeam[t] = coachesByTeam[t] || []).push({ id: r.id, name: r.name || d.full_name || `#${r.id}`, role: d.role || "", present: checked.has(r.id) }); }

    let players = all;
    if (b.league) players = players.filter((p) => p.league === b.league);
    if (b.division) players = players.filter((p) => p.division === b.division);
    if (b.team) players = players.filter((p) => p.team === b.team);
    players.sort((a, c) => String(a.name).localeCompare(String(c.name)));

    return Response.json({
      players, present: players.filter((p) => checked.has(p.id)).length, total: players.length,
      leagues, divisions, teams, coachesByTeam, fields,
    });
  }

  if (b.action === "toggle") {
    const res = setCheckin(b.player_id, b.player, b.week, b.present);
    // Fan-out to any open Board / live view so they refresh without waiting
    // for the next slow-poll tick.
    emit("checkin", { player_id: Number(b.player_id), player: b.player, week: b.week, present: !!b.present, via: "board" });
    return Response.json(res);
  }

  if (b.action === "confirm_size") {
    // On-site gate before printing: stamp size confirmation + (optionally) update size + check in.
    setActorFromReq(req);
    const pid = Number(b.player_id);
    const row = getRow("records", pid);
    if (!row || row.type !== "player") return Response.json({ error: "Player not found." });
    let d = {}; try { d = JSON.parse(row.data || "{}"); } catch {}
    const newSize = (b.jersey_size || "").trim();
    const allowed = ["YS", "YM", "YL", "AS", "AM", "AL"];
    if (!newSize) return Response.json({ error: "Pick a jersey size." });
    if (!allowed.includes(newSize)) return Response.json({ error: "Unknown jersey size: " + newSize });
    if (!b.confirmed) return Response.json({ error: "Tick the confirmation box first." });
    const patch = {
      size_confirmed_at: now(),
      size_confirmed_by: getActor(),
    };
    if (newSize !== (d.jersey_size || "")) patch.jersey_size = newSize;
    updateRecord(pid, patch);
    if (b.week && b.player) setCheckin(pid, b.player, b.week, true);
    logAudit(getActor(), "confirm_size", "records", pid, { jersey_size: d.jersey_size || "" }, { jersey_size: newSize, confirmed_at: patch.size_confirmed_at }, "on-site size confirmation");
    // Push to the live event bus so the admin Board lights up instantly.
    emit("checkin", { player_id: pid, player: b.player || row.name, week: b.week, present: true, via: "kiosk", jersey_size: newSize });
    return Response.json({ ok: true, jersey_size: newSize, size_confirmed_at: patch.size_confirmed_at, size_confirmed_by: patch.size_confirmed_by });
  }

  if (b.action === "report") {
    seedAttendance();
    const recs = getRecords("attendance").map((r) => parse(r.data));
    // Season weeks come from the SCHEDULE (each game's week), so every week of the season shows
    // as a column even before anyone is checked in. Also include any weeks already marked.
    const games = getRecords("game").map((r) => parse(r.data));
    const scopedGames = b.league ? games.filter((g) => String(g.league || "") === b.league) : games;
    const weeksSet = new Set();
    for (const g of scopedGames) { const w = weekStartISO(g.date); if (w) weeksSet.add(w); }
    for (const r of recs) if (r.week) weeksSet.add(String(r.week));
    if (b.week) weeksSet.add(String(b.week)); // always include the current week
    const weeks = [...weeksSet].sort().slice(0, 30); // chronological (Week 1 → last)
    const byPlayer = {};
    for (const r of recs) { const id = Number(r.player_id); (byPlayer[id] = byPlayer[id] || new Set()).add(String(r.week)); }
    const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => { const d = parse(r.data); return { id: r.id, name: r.name || d.full_name || `#${r.id}`, league: d.league || "", division: d.division || "", team: d.team || "" }; });
    let players = all.slice();
    if (b.league) players = players.filter((p) => p.league === b.league);
    if (b.division) players = players.filter((p) => p.division === b.division);
    if (b.team) players = players.filter((p) => p.team === b.team);
    players.sort((a, c) => String(a.name).localeCompare(String(c.name)));
    const out = players.map((p) => { const set = byPlayer[p.id] || new Set(); return { ...p, present: weeks.map((w) => set.has(w)), count: set.size }; });
    return Response.json({
      weeks, players: out, totalWeeks: weeksSet.size,
      leagues: [...new Set(all.map((p) => p.league).filter(Boolean))],
      divisions: [...new Set(all.map((p) => p.division).filter(Boolean))],
      teams: [...new Set(all.map((p) => p.team).filter(Boolean))],
    });
  }

  if (b.action === "scan") {
    seedAttendance();
    const q = String(b.query || "").trim();
    if (!q) return Response.json({ status: "empty" });
    const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => ({ id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data) }));
    let matches;
    if (/^#?\d+$/.test(q)) {
      const idn = Number(q.replace(/^#/, ""));
      matches = all.filter((p) => p.id === idn);
      if (!matches.length) matches = all.filter((p) => [p.key_tag, p.keytag, p.badge, p.jersey_number, p.number].some((v) => String(v ?? "") === q));
    } else {
      const ql = q.toLowerCase();
      matches = all.filter((p) => String(p.name).toLowerCase() === ql);
      if (!matches.length) matches = all.filter((p) => String(p.name).toLowerCase().includes(ql));
    }
    if (!matches.length) return Response.json({ status: "not_found", query: q });
    if (matches.length > 1) return Response.json({ status: "ambiguous", query: q, matches: matches.slice(0, 8).map((p) => ({ id: p.id, name: p.name, team: p.team || "", league: p.league || "" })) });
    const p = matches[0];
    const already = getCheckins(b.week).has(p.id);
    if (!already) {
      setCheckin(p.id, p.name, b.week, true);
      emit("checkin", { player_id: p.id, player: p.name, week: b.week, present: true, via: "scan" });
    }
    return Response.json({ status: already ? "already" : "checked_in", player: { id: p.id, name: p.name, team: p.team || "", league: p.league || "" } });
  }

  return Response.json({ error: "unknown action" });
}
