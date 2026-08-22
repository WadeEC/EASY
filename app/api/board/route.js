import { getRecords, getFields, updateRecord, setCheckin, getCheckins, seedAttendance, flagsForPlayer, ensurePlayerNotes, ensurePlayerKeyTag } from "@/lib/tools.js";
import { bindRequest, getActor } from "@/lib/actor.js";
import { seasonFromReq, inSeason } from "@/lib/seasons.js";

export const dynamic = "force-dynamic";
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const digits = (s) => String(s || "").replace(/\D+/g, "");

// The red "needs attention" items for a player: missing jersey size, any alerts (flags), jersey not handed out.
function playerIssues(p) {
  const issues = [];
  if (!String(p.jersey_size || "").trim()) issues.push("No jersey size");
  for (const f of flagsForPlayer(p)) issues.push(f);
  if (p.jersey_issued !== true) issues.push("Jersey not issued");
  return issues;
}

function scanDetail(p) {
  const team = p.team || "";
  const coaches = getRecords("coach")
    .map((r) => { const d = parse(r.data); return { name: r.name || d.full_name || `#${r.id}`, role: d.role || "", team: d.team || "" }; })
    .filter((c) => team && c.team === team)
    .map((c) => ({ name: c.name, role: c.role }));
  const games = getRecords("game").map((r) => parse(r.data))
    .filter((g) => team && (g.home_team === team || g.away_team === team))
    .sort((a, b) => (Number(a.week) || 0) - (Number(b.week) || 0))
    .map((g) => ({ week: g.week, date: g.date || "", time: g.time || "", location: g.location || "", vs: (g.home_team === team ? g.away_team : g.home_team) || "" }));
  const field = (games[0] && games[0].location) || p.league || "";
  return {
    player: { id: p.id, name: p.name, age: p.age ?? "", division: p.division || "", league: p.league || "" },
    team, coaches, field, games, notes: p.notes || "", flags: flagsForPlayer(p),
    jerseySize: p.jersey_size || "", jerseyIssued: p.jersey_issued === true,
    sizeConfirmedAt: p.size_confirmed_at || "", sizeConfirmedBy: p.size_confirmed_by || "",
    issues: playerIssues(p),
  };
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  const season = seasonFromReq(req); // sidebar season picker

  if (b.action === "board") {
    ensurePlayerNotes(); ensurePlayerKeyTag(); seedAttendance();
    const checked = getCheckins(b.week);
    const fields = getFields("player").map((f) => ({ name: f.name, label: f.label, data_type: f.data_type, required: !!f.required, options: f.options }));
    const players = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => {
      const d = parse(r.data);
      const issues = playerIssues({ id: r.id, ...d });
      return { id: r.id, name: r.name || d.full_name || `#${r.id}`, team: d.team || "", league: d.league || "", division: d.division || "", present: checked.has(r.id), data: d, issues, status: issues.length ? "flag" : "clear" };
    });
    return Response.json({
      players, fields,
      leagues: [...new Set(players.map((p) => p.league).filter(Boolean))],
      divisions: [...new Set(players.map((p) => p.division).filter(Boolean))],
    });
  }

  if (b.action === "scan") {
    seedAttendance();
    const q = String(b.query || "").trim();
    if (!q) return Response.json({ status: "empty" });
    const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => ({ id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data) }));
    const dq = digits(q);
    let matches;
    if (/[a-z]/i.test(q)) { const ql = q.toLowerCase(); matches = all.filter((p) => String(p.name).toLowerCase().includes(ql)); }
    else { matches = all.filter((p) => p.id === Number(dq) || [p.keytag, p.key_tag, p.badge, p.jersey_number, p.number].some((v) => String(v ?? "") === q)); }
    if (!matches.length) return Response.json({ status: "not_found", query: q });
    if (matches.length > 1) return Response.json({ status: "ambiguous", matches: matches.slice(0, 8).map((p) => ({ id: p.id, name: p.name, team: p.team || "" })) });
    const p = matches[0];
    const already = getCheckins(b.week).has(p.id);
    if (!already) setCheckin(p.id, p.name, b.week, true);
    return Response.json({ status: already ? "already" : "checked_in", ...scanDetail(p) });
  }

  if (b.action === "scan_id") {
    const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => ({ id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data) }));
    const p = all.find((x) => x.id === Number(b.player_id));
    if (!p) return Response.json({ status: "not_found" });
    const already = getCheckins(b.week).has(p.id);
    if (!already) setCheckin(p.id, p.name, b.week, true);
    return Response.json({ status: already ? "already" : "checked_in", ...scanDetail(p) });
  }

  if (b.action === "detail") {
    seedAttendance();
    const all = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => ({ id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data) }));
    const p = all.find((x) => x.id === Number(b.player_id));
    if (!p) return Response.json({ status: "not_found" });
    const present = getCheckins(b.week).has(p.id);
    return Response.json({ status: present ? "already" : "checked_out", ...scanDetail(p) });
  }

  if (b.action === "note") {
    const res = updateRecord(Number(b.player_id), { notes: b.notes || "" });
    return Response.json(res.error ? { error: res.error } : { status: "saved" });
  }
  if (b.action === "toggle") { setCheckin(Number(b.player_id), b.player || "", b.week, !!b.present); return Response.json({ status: "ok", present: !!b.present }); }
  // Set the size on the spot. The size is the thing you find out AT the table
  // — the kid is standing there and the sheet says nothing — so it has to be
  // editable where the jersey is handed over, not three screens away.
  if (b.action === "set_jersey_size") {
    const want = String(b.size == null ? "" : b.size).trim();
    const f = getFields("player").find((x) => x.name === "jersey_size");
    let opts = []; try { opts = f && f.options ? JSON.parse(f.options) : []; } catch {}
    if (want && opts.length) {
      const hit = opts.find((o) => String(o).trim().toLowerCase() === want.toLowerCase());
      if (!hit) return Response.json({ error: `"${want}" isn't one of the jersey sizes (${opts.join(", ")}).` });
      // Choosing the size here is a staff member confirming it on-site, which
      // is exactly what the press rule means by "confirmed at check-in". Same
      // stamp the kiosk writes, so the two paths can't disagree.
      const stamp = new Date().toISOString().slice(0, 19);
      const res = updateRecord(Number(b.player_id),
        { jersey_size: hit, size_confirmed_at: stamp, size_confirmed_by: getActor() },
        "user(check-in)", "confirmed jersey size at check-in");
      return Response.json(res.error ? { error: res.error } : { status: "ok", size: hit, size_confirmed_at: stamp });
    }
    // Cleared the size — the confirmation goes with it. A confirmation with no
    // size behind it is the kind of half-truth that gets a jersey misprinted.
    const res = updateRecord(Number(b.player_id),
      { jersey_size: "", size_confirmed_at: "", size_confirmed_by: "" },
      "user(check-in)", "cleared jersey size at check-in");
    return Response.json(res.error ? { error: res.error } : { status: "ok", size: "", size_confirmed_at: "" });
  }
  if (b.action === "set_jersey") {
    const res = updateRecord(Number(b.player_id), { jersey_issued: !!b.issued });
    return Response.json(res.error ? { error: res.error } : { status: "ok", issued: !!b.issued });
  }

  return Response.json({ error: "unknown action" });
}
