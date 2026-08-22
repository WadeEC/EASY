export function icon(name) {
  const t = { player: "🧒", team: "🟦", coach: "🧑‍🏫", division: "🏷️", game: "🏈",
    referee: "🦓", field: "📍", season: "📅", parent: "👪", jersey: "👕" };
  const n = (name || "").toLowerCase();
  for (const k in t) if (n.includes(k)) return t[k];
  return "📋";
}

export function plural(label) {
  label = label || "";
  if (!label) return label;
  const l = label.toLowerCase();
  if (l.endsWith("s")) return label;                                              // already plural (players, leagues)
  if (l.endsWith("ch") || l.endsWith("sh") || l.endsWith("x") || l.endsWith("z")) return label + "es"; // coach -> coaches
  if (l.endsWith("y") && !"aeiou".includes(l[l.length - 2])) return label.slice(0, -1) + "ies";        // city -> cities
  return label + "s";
}

// ---------------------------------------------------------------- divisions
//
// Every Division dropdown in the app should come from the divisions you
// DEFINED, not from the distinct strings sitting in players' division fields.
// Deriving the list from the data is how a picker ends up offering "10" — an
// age that got written into the field by an upload.
//
// Two rules that were getting missed:
//   - A division with no league set applies to EVERY league. Filtering with
//     `d.league === league` silently hides all of them the moment a league is
//     picked, which is why the Team Builder's Division list looked empty.
//   - Youngest bracket first. A division is an age range; alphabetical puts
//     "Ages 11-12" above "Ages 4-6", which reads as a mistake.
//
// The list is ONLY the brackets you defined. Values found on records that
// aren't a bracket are not offered: nothing resolves to them any more (a
// player is in "Ages 9-10" because they're 9 or 10 — see divisionOf on the
// server), so an option called "10 — not a division" would filter to nobody.
const numOr = (v, fallback) => (v === "" || v == null ? fallback : Number(v));

export function divisionsForLeague(divisions, league) {
  return (divisions || [])
    .filter((d) => !d.league || !league || d.league === league)
    .slice()
    .sort((a, b) => numOr(a.age_min, -Infinity) - numOr(b.age_min, -Infinity)
      || numOr(a.age_max, Infinity) - numOr(b.age_max, Infinity)
      || String(a.name || "").localeCompare(String(b.name || "")));
}

// [{ value, label }] ready to render as <option>s. `seen` is accepted and
// ignored — it used to append stray values, which produced a dropdown full of
// "10 — not a division".
export function divisionChoices(divisions, league, seen = []) {   // eslint-disable-line no-unused-vars
  return divisionsForLeague(divisions, league).map((d) => ({
    value: d.name,
    label: `${d.name}${d.age_min != null && d.age_min !== "" ? ` (${d.age_min}–${d.age_max ?? ""})` : ""}`,
  }));
}

// The leagues you CONFIGURED, from the player schema's league field — plus any
// league actually on a record that isn't configured, so nobody is stranded.
// Never just the distinct values found on the players in view: a league with
// nobody in it yet would vanish from the picker, and you could never select it
// to put someone there.
export function leagueChoices(fields, seen = []) {
  let opts = [];
  try {
    const f = (fields || []).find((x) => x.name === "league");
    opts = f && f.options ? (typeof f.options === "string" ? JSON.parse(f.options) : f.options) : [];
  } catch { opts = []; }
  const out = (opts || []).map((l) => String(l));
  const known = new Set(out.map((l) => l.toLowerCase()));
  for (const v of [...new Set((seen || []).map((x) => String(x || "").trim()).filter(Boolean))].sort()) {
    if (!known.has(v.toLowerCase())) out.push(v);
  }
  return out;
}

// The client-side twin of the server's divisionOf: which bracket is this
// player in? Their AGE decides, unless a real bracket was set on purpose.
export function resolveDivision(divisions, p) {
  const norm = (x) => String(x == null ? "" : x).trim().toLowerCase().replace(/\s+/g, " ");
  const all = divisions || [];
  const stored = norm(p && p.division);
  if (stored) {
    const hit = all.find((d) => norm(d.name) === stored);
    if (hit) return hit.name;
  }
  const age = Number(p && p.age);
  if (!Number.isFinite(age) || String((p && p.age) ?? "").trim() === "") return "";
  const b = divisionsForLeague(all, (p && p.league) || "").find((d) =>
    age >= numOr(d.age_min, -Infinity) && age <= numOr(d.age_max, Infinity));
  return b ? b.name : "";
}

export function recordName(rec) {
  try {
    const d = JSON.parse(rec.data || "{}");
    return rec.name || d.full_name || d.name || `#${rec.id}`;
  } catch { return rec.name || `#${rec.id}`; }
}

export function friendlyAudit(e) {
  const who = (e.actor || "").startsWith("user") ? "You" : "The AI";
  const verb = { create: "added", update: "updated", delete: "removed" }[e.action] || e.action;
  const thing = { records: "record", fields: "field", rules: "rule", record_types: "section" }[e.target_table] || e.target_table;
  return `${who} ${verb} a ${thing}` + (e.undone ? " — since undone" : "");
}

const cap = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const after = (e) => { try { return e.after ? JSON.parse(e.after) : {}; } catch { return {}; } };

// Friendly timestamp. Stored times are UTC (ISO sliced), so treat as UTC then show local.
export function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso.length <= 19 ? iso + "Z" : iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "Today " + t;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + t;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
}

// Group consecutive audit entries (same actor, same minute) into one friendly line.
export function summarizeActivity(entries) {
  const groups = [];
  for (const e of entries || []) {
    const minute = (e.created_at || "").slice(0, 16);
    const last = groups[groups.length - 1];
    if (last && last.actor === e.actor && last.minute === minute && !e.undone && !last.undone)
      last.items.push(e);
    else groups.push({ actor: e.actor, minute, time: e.created_at, undone: !!e.undone, items: [e] });
  }
  return groups.map((g) => ({ text: phrase(g), time: formatTime(g.time) }));
}

function oneVerb(e) {
  const verb = { create: "added", update: "updated", delete: "removed" }[e.action] || e.action;
  const thing = { records: "record", fields: "detail", rules: "rule", record_types: "section" }[e.target_table] || e.target_table;
  return `${verb} a ${thing}` + (e.undone ? " — since undone" : "");
}

function phrase(g) {
  const who = (g.actor || "").startsWith("user") ? "You" : "The AI";
  if (g.items.length === 1) return `${who} ${oneVerb(g.items[0])}`;
  const typeCreates = g.items.filter((e) => e.target_table === "record_types" && e.action === "create");
  const fieldCreates = g.items.filter((e) => e.target_table === "fields" && e.action === "create");
  const recCreates = g.items.filter((e) => e.target_table === "records" && e.action === "create");
  if (typeCreates.length && fieldCreates.length) {
    const label = after(typeCreates[0]).label || after(typeCreates[0]).name || "a";
    return `${who} set up the ${cap(label)} section with ${fieldCreates.length} detail${fieldCreates.length > 1 ? "s" : ""}`;
  }
  const parts = [];
  if (typeCreates.length) parts.push(`set up ${typeCreates.length} section${typeCreates.length > 1 ? "s" : ""}`);
  if (fieldCreates.length) { const rt = after(fieldCreates[0]).record_type; parts.push(`added ${fieldCreates.length} details${rt ? " to " + cap(rt) : ""}`); }
  if (recCreates.length) parts.push(`added ${recCreates.length} record${recCreates.length > 1 ? "s" : ""}`);
  if (!parts.length) parts.push(`made ${g.items.length} changes`);
  return `${who} ${parts.join(", ")}`;
}
