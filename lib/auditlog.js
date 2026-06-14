// Shared, client-safe helpers for turning raw audit rows into human-readable change entries.
// Used by the Change log (read-only) and the Time Machine (revert).

const parseJSON = (s) => { if (s == null) return null; if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return null; } };
const dataOf = (rec) => { if (!rec) return {}; const d = rec.data; if (typeof d === "string") { try { return JSON.parse(d || "{}"); } catch { return {}; } } return d || {}; };
const nameOf = (rec, d) => (rec && rec.name) || d.full_name || d.name || (rec ? `#${rec.id}` : "record");

const TYPE_LABEL = { player: "player", coach: "coach", game: "game", referee: "referee", tournament: "tournament", team: "team", division: "division" };
const FIELD_LABEL = { team: "team", league: "league", division: "division", jersey_size: "jersey size", jersey_issued: "jersey issued", referee: "referee", time: "time", location: "field", home_team: "home", away_team: "away", week: "week", date: "date", full_name: "name", phone: "phone", field: "home field", age: "age", end_season_rank: "end-of-season rank", rank_season: "rank season" };

export const CATS = ["All", "Players & rosters", "Schedule", "Referees", "Tournaments", "Other"];
export const ACTOR_LABEL = (a) => a === "ai" ? "Assistant" : a === "system" ? "System" : (a || "Admin");

export function catOf(type) {
  if (["player", "coach", "team"].includes(type)) return "Players & rosters";
  if (type === "game") return "Schedule";
  if (type === "referee") return "Referees";
  if (type === "tournament") return "Tournaments";
  return "Other";
}

// Only data records (player/game/team/referee/...) can be reverted from the UI — never
// schema rows (fields, record types), which would break the app.
export function isRevertible(e) {
  return !e.undone && e.target_table === "records" && ["create", "update", "delete"].includes(e.action);
}

const fmtVal = (v) => v === true ? "yes" : v === false ? "no" : (v == null || v === "" ? "—" : String(v));
function diffFields(bd, ad) {
  const out = {}; const keys = new Set([...Object.keys(bd || {}), ...Object.keys(ad || {})]);
  for (const k of keys) { const a = bd ? bd[k] : undefined, b = ad ? ad[k] : undefined; if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b }; }
  return out;
}
function changeSummary(changes) {
  const keys = Object.keys(changes).filter((k) => !["updated_at", "created_at"].includes(k));
  const parts = keys.slice(0, 4).map((k) => `${FIELD_LABEL[k] || k.replace(/_/g, " ")}: ${fmtVal(changes[k].from)} → ${fmtVal(changes[k].to)}`);
  if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
  return parts.join(" · ");
}

// Raw audit row -> { cat, text, detail }.
export function describe(e) {
  const before = parseJSON(e.before), after = parseJSON(e.after);
  if (e.target_table === "records") {
    const rec = after || before;
    const type = (rec && rec.type) || "record";
    const bd = dataOf(before), ad = dataOf(after);
    const data = after ? ad : bd;
    const name = nameOf(rec, data);
    const label = TYPE_LABEL[type] || type;
    const cat = catOf(type);
    if (e.action === "create") {
      const extra = type === "game" ? `${ad.home_team || ""} vs ${ad.away_team || ""}${ad.time ? ` · ${ad.time}` : ""}${ad.location ? ` · ${ad.location}` : ""}` : "";
      return { cat, text: `Added ${label} ${name}`, detail: extra };
    }
    if (e.action === "delete") {
      const extra = type === "game" ? `${bd.home_team || ""} vs ${bd.away_team || ""}` : "";
      return { cat, text: `Removed ${label} ${name}`, detail: extra };
    }
    const changes = diffFields(bd, ad);
    if (type === "player" && changes.team) return { cat, text: `Moved ${name}`, detail: `${changes.team.from || "Unassigned"} → ${changes.team.to || "Unassigned"}` };
    if (type === "game" && changes.referee) return { cat, text: `Reassigned referee on ${name}`, detail: `${changes.referee.from || "none"} → ${changes.referee.to || "none"}` };
    return { cat, text: `Updated ${label} ${name}`, detail: changeSummary(changes) };
  }
  return { cat: "Other", text: e.reason || `${e.action} ${e.target_table}`, detail: "" };
}
