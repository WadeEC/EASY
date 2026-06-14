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
