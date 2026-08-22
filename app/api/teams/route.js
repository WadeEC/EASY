import {
  getRecords, getFields, getRecordTypes, addField, updateRecord,
  createTeamRule, getTeamRules, deleteRule, setRuleActive,
  seedCoaches, getCoaches, setAllStarCap, lowAvailabilitySet,
  linkData, listLinks, getDivisions,
} from "@/lib/tools.js";
import { buildTeams } from "@/lib/teams.js";
import { bindRequest } from "@/lib/actor.js";
import { seasonFromReq, inSeason, leaguesForSeason } from "@/lib/seasons.js";

export const dynamic = "force-dynamic";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  const season = seasonFromReq(req); // sidebar season picker — null = all seasons

  if (b.action === "config") {
    const hasPlayer = getRecordTypes().some((t) => t.name === "player");
    if (hasPlayer && getTeamRules().length === 0) createTeamRule("keep_together", "__siblings__"); // sensible default
    if (getRecordTypes().some((t) => t.name === "coach") && !getTeamRules().some((r) => r.type === "coach_child"))
      createTeamRule("coach_child", "", "Keep each coach's child on their team"); // admin can toggle this
    const fields = getFields("player");
    const lf = fields.find((f) => f.name === "league");
    let leagues = lf && lf.options ? JSON.parse(lf.options) : [];
    const snLeagues = leaguesForSeason(season);
    if (snLeagues) leagues = leagues.filter((l) => snLeagues.includes(l));
    return Response.json({
      hasPlayer,
      hasCoach: getRecordTypes().some((t) => t.name === "coach"),
      leagues,
      fields: fields.map((f) => ({ name: f.name, label: f.label, type: f.data_type })),
      rules: getTeamRules(),
    });
  }

  if (b.action === "setup_coaches") return Response.json(seedCoaches());
  if (b.action === "set_all_star_cap") return Response.json(setAllStarCap(b.max));
  if (b.action === "low_avail") return Response.json({ ids: [...lowAvailabilitySet()] });

  if (b.action === "link") {
    if (!getFields("player").some((f) => f.name === "link_group")) addField("player", "link_group", "text", "Link group");
    if (!getFields("player").some((f) => f.name === "link_reason")) addField("player", "link_reason", "text", "Link reason");
    if (!getTeamRules().some((r) => r.type === "keep_together" && r.field === "link_group"))
      createTeamRule("keep_together", "link_group", "Keep linked players together");
    const group = b.group || ("group-" + Date.now().toString(36));
    const reason = (b.reason == null ? null : String(b.reason).trim());
    let count = 0;
    for (const id of b.ids || []) {
      const patch = { link_group: group };
      if (reason !== null) patch.link_reason = reason;
      updateRecord(id, patch);
      count++;
    }
    return Response.json({ status: "linked", group, reason: reason || "", count });
  }
  if (b.action === "set_link_reason") {
    if (!getFields("player").some((f) => f.name === "link_reason")) addField("player", "link_reason", "text", "Link reason");
    const g = (b.group || "").trim();
    if (!g) return Response.json({ error: "Group required" });
    const reason = (b.reason == null ? "" : String(b.reason).trim());
    let count = 0;
    for (const r of getRecords("player")) {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      if ((d.link_group || "") === g) { updateRecord(r.id, { link_reason: reason }); count++; }
    }
    return Response.json({ status: "ok", group: g, reason, count });
  }
  if (b.action === "unlink") { updateRecord(b.id, { link_group: "" }); return Response.json({ status: "unlinked" }); }

  if (b.action === "add_rule") return Response.json(createTeamRule(b.type, b.field));
  if (b.action === "del_rule") return Response.json(deleteRule(b.id));
  if (b.action === "toggle_rule") return Response.json(setRuleActive(b.id, b.active));

  // Build each age bracket on its own, in one call.
  //
  // A league is not one pool. Building 217 players into 22 teams mixes a
  // five-year-old with a fifteen-year-old and calls it balanced. Divisions
  // exist precisely so that doesn't happen, so this is the default the UI
  // offers: one balanced set of teams per bracket, names prefixed with the
  // bracket ("Ages 9-10 / Team 1") so they can't collide.
  if (b.action === "preview" && b.per_division) {
    const all = getRecords("player").map((r) => ({ id: r.id, name: r.name, ...parse(r.data) }))
      .filter((p) => inSeason(p, season));
    const inLeague = b.league
      ? all.filter((p) => (p.league || "") === b.league || (p.second_league || "") === b.league)
      : all;
    if (!inLeague.length) return Response.json({ total: 0, teams: [], slices: [] });

    const lowSet = lowAvailabilitySet();
    for (const p of inLeague) p._low = lowSet.has(p.id);
    const allRules = getTeamRules();
    const rules = allRules.filter((r) => r.active).map((r) => ({ type: r.type, field: r.field, max: r.max }));
    const ccRule = allRules.find((r) => r.type === "coach_child");
    const coachChild = ccRule ? !!ccRule.active : true;
    const capRule = allRules.find((r) => r.type === "cap" && r.active) || null;
    const capField = capRule ? capRule.field : null;
    const coaches = getCoaches(b.league || null);
    const links = linkData();

    // A division with no league set applies to every league.
    const brackets = getDivisions().filter((d) => !d.league || !b.league || d.league === b.league);
    const slices = brackets.map((d) => ({ name: d.name, players: inLeague.filter((p) => (p.division || "") === d.name) }));
    const noDiv = inLeague.filter((p) => !String(p.division || "").trim());
    if (noDiv.length) slices.push({ name: "", players: noDiv, unsorted: true });

    const outTeams = [], report = [], conflicts = [];
    for (const sl of slices) {
      if (!sl.players.length) { report.push({ division: sl.name || "(no division)", players: 0, teams: 0 }); continue; }
      const r = buildTeams(sl.players, {
        numTeams: null,                                    // per-bracket sizing, never one league-wide count
        targetSize: b.targetSize ? Number(b.targetSize) : null,
        rules, coaches, coachChild, links,
      });
      const prefix = sl.name ? `${sl.name} / ` : "No division / ";
      for (const t of (r.teams || [])) {
        outTeams.push({ ...t, name: prefix + t.name, division: sl.name || "" });
      }
      conflicts.push(...(r.conflicts || []));
      report.push({ division: sl.name || "(no division)", players: sl.players.length, teams: (r.teams || []).length, unsorted: !!sl.unsorted });
    }

    const linkKindsByPlayer = new Map();
    for (const g of listLinks()) {
      for (const pid of g.players) {
        const arr = linkKindsByPlayer.get(pid) || [];
        if (!arr.find((x) => x.link_id === g.link_id)) arr.push({ link_id: g.link_id, kind: g.kind, reason: g.reason || "" });
        linkKindsByPlayer.set(pid, arr);
      }
    }
    return Response.json({
      total: inLeague.length,
      per_division: true,
      slices: report,
      balanceField: (outTeams[0] && outTeams[0].balanceField) || "age",
      hasCoaches: coaches.length > 0,
      cap: capRule ? { field: capField, max: Number(capRule.max) || null } : null,
      linkConflicts: conflicts,
      teams: outTeams.map((t) => ({
        name: t.name, division: t.division, size: t.size, ageAvg: t.ageAvg, metricAvg: t.metricAvg, balanceField: t.balanceField,
        players: t.players.map((p) => ({ id: p.id, name: p.name || p.full_name || `#${p.id}`, age: p.age, group: p.link_group || "", reason: p.link_reason || "", unit: p._u, star: capField ? !!p[capField] : false, pinned: !!p._pin, low: !!p._low, linkKinds: linkKindsByPlayer.get(p.id) || [] })),
        coaches: (t.coaches || []).map((c) => ({ id: c.id, name: c.name, role: c.role })),
      })),
    });
  }

  if (b.action === "preview") {
    const all = getRecords("player").map((r) => ({ id: r.id, name: r.name, ...parse(r.data) }))
      .filter((p) => inSeason(p, season));
    let players = b.league
      ? all.filter((p) => (p.league || "") === b.league || (p.second_league || "") === b.league)
      : all;
    if (b.division) players = players.filter((p) => (p.division || "") === b.division);
    const lowSet = lowAvailabilitySet();          // attendance < half the weeks so far
    for (const p of players) p._low = lowSet.has(p.id);
    const allRules = getTeamRules();
    const rules = allRules.filter((r) => r.active).map((r) => ({ type: r.type, field: r.field, max: r.max }));
    const ccRule = allRules.find((r) => r.type === "coach_child");
    const coachChild = ccRule ? !!ccRule.active : true; // default on if no rule yet
    const capRule = allRules.find((r) => r.type === "cap" && r.active) || null;
    const capField = capRule ? capRule.field : null;
    const coaches = getCoaches(b.league || null);
    const links = linkData();
    const result = buildTeams(players, {
      numTeams: b.numTeams ? Number(b.numTeams) : null,
      targetSize: b.targetSize ? Number(b.targetSize) : null,
      rules,
      coaches,
      coachChild,
      links,
    });
    const teams = result.teams || [];
    const conflicts = result.conflicts || [];
    // Build a per-player map of explicit link memberships so the UI can render the kind.
    const linkKindsByPlayer = new Map();
    for (const g of listLinks()) {
      for (const pid of g.players) {
        const arr = linkKindsByPlayer.get(pid) || [];
        if (!arr.find((x) => x.link_id === g.link_id)) arr.push({ link_id: g.link_id, kind: g.kind, reason: g.reason || "" });
        linkKindsByPlayer.set(pid, arr);
      }
    }
    return Response.json({
      total: players.length,
      balanceField: (teams[0] && teams[0].balanceField) || "age",
      hasCoaches: coaches.length > 0,
      cap: capRule ? { field: capField, max: Number(capRule.max) || null } : null,
      linkConflicts: conflicts,
      teams: teams.map((t) => ({
        name: t.name, size: t.size, ageAvg: t.ageAvg, metricAvg: t.metricAvg, balanceField: t.balanceField,
        players: t.players.map((p) => ({ id: p.id, name: p.name || p.full_name || `#${p.id}`, age: p.age, group: p.link_group || "", reason: p.link_reason || "", unit: p._u, star: capField ? !!p[capField] : false, pinned: !!p._pin, low: !!p._low, linkKinds: linkKindsByPlayer.get(p.id) || [] })),
        coaches: (t.coaches || []).map((c) => ({ id: c.id, name: c.name, role: c.role })),
      })),
    });
  }

  if (b.action === "save") {
    if (!getFields("player").some((f) => f.name === "team")) addField("player", "team", "text", "Team");
    let saved = 0;
    const blocked = [];
    for (const t of b.teams || []) for (const id of t.ids || []) {
      const res = updateRecord(id, { team: t.name });
      if (res.error) blocked.push({ id, reason: res.error }); else saved++;
    }
    let coachesSaved = 0;
    const anyCoaches = (b.teams || []).some((t) => (t.coachIds || []).length);
    if (anyCoaches && getRecordTypes().some((x) => x.name === "coach")) {
      if (!getFields("coach").some((f) => f.name === "team")) addField("coach", "team", "text", "Team");
      for (const t of b.teams || []) for (const id of t.coachIds || []) {
        const res = updateRecord(id, { team: t.name });
        if (res.error) blocked.push({ id, reason: res.error }); else coachesSaved++;
      }
    }
    // Say what didn't save. A silent partial write is worse than a refusal.
    if (blocked.length && !saved && !coachesSaved) return Response.json({ error: blocked[0].reason });
    return Response.json({ saved, coachesSaved, blocked: blocked.length, blocked_details: blocked.slice(0, 10) });
  }

  return Response.json({ error: "unknown action" });
}
