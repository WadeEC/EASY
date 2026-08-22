import { bindRequest } from "@/lib/actor.js";
// Active check-in week — shared between the admin Team Board and the Kiosk.
// Stored as a league-scope setting in ai_facts (key="setting:active_checkin_week").
// When unset, the client falls back to the current calendar week.
//
//   GET                                  → { week, weeks, weekList, current }
//   POST { week }                        → set the active week (blank clears)
//   POST { action:"label", week, label } → rename a week ("" restores Week N)
//   POST { action:"cancel", week, cancelled } → cancel/uncancel; numbering shifts
import { getSetting, setSetting } from "@/lib/memory.js";
import { seasonWeekList, setWeekLabel, setWeekCancelled } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

function currentWeekISO() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

export async function GET(req) {
  bindRequest(req);
  const week = getSetting("active_checkin_week", null);
  let weekList = [];
  try { weekList = seasonWeekList(); } catch { weekList = []; }
  return Response.json({
    week,
    weekList,
    weeks: weekList.map((w) => w.week),   // back-compat: plain ISO list
    current: currentWeekISO(),
  });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json().catch(() => ({}));

  if (b.action === "label") return Response.json(setWeekLabel(b.week, b.label));
  if (b.action === "cancel") return Response.json(setWeekCancelled(b.week, b.cancelled !== false));

  const w = (b.week || "").trim();
  if (w && !/^\d{4}-\d{2}-\d{2}$/.test(w)) return Response.json({ error: "week must be YYYY-MM-DD" });
  const res = setSetting("active_checkin_week", w || null);
  return Response.json({ week: w || null, ...res });
}
