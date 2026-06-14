// Active check-in week — shared between the admin Team Board and the Kiosk.
// Stored as a league-scope setting in ai_facts (key="setting:active_checkin_week").
// When unset, the client falls back to the current calendar week.
//
//   GET                   → { week: "YYYY-MM-DD" | null }
//   POST { week }         → sets it (or clears with empty/null)
import { getSetting, setSetting } from "@/lib/memory.js";
import { seasonWeeks } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

function currentWeekISO() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  const week = getSetting("active_checkin_week", null);
  const weeks = [];
  try { for (const w of seasonWeeks()) weeks.push(w); } catch {}
  const now = currentWeekISO();
  if (!weeks.includes(now)) weeks.push(now);
  weeks.sort();
  return Response.json({ week, weeks, current: now });
}

export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const w = (b.week || "").trim();
  if (w && !/^\d{4}-\d{2}-\d{2}$/.test(w)) return Response.json({ error: "week must be YYYY-MM-DD" });
  const res = setSetting("active_checkin_week", w || null);
  return Response.json({ week: w || null, ...res });
}
