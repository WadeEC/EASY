import { bindRequest } from "@/lib/actor.js";
import { promises as fs } from "fs";
import path from "path";
import { getDb } from "@/lib/db.js";
import { addFieldOption } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

const MARKERS_PATH = path.join(process.cwd(), "_imports", "markers.json");

async function readMarkers() {
  try {
    const raw = await fs.readFile(MARKERS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, districts: {} };
  }
}

async function writeMarkersAtomic(obj) {
  const dir = path.dirname(MARKERS_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmp = MARKERS_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, MARKERS_PATH);
}

function dedupMarkers(existing, incoming) {
  const seen = new Map(); // lowercased value -> entry
  const all = [...(existing || []), ...(incoming || [])];
  for (const m of all) {
    if (!m || !m.value) continue;
    const key = String(m.value).toLowerCase().trim();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, { value: m.value, tier: Number(m.tier) || 1 });
    }
  }
  return Array.from(seen.values());
}

// POST { district, league?, newMarkers?: [{value, tier}], createDistrict?: bool }
export async function POST(req) {
  bindRequest(req);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }

  const district = (body.district || "").trim();
  if (!district) return Response.json({ error: "district required" }, { status: 400 });

  const league = body.league ? String(body.league).trim() : null;
  const newMarkers = Array.isArray(body.newMarkers) ? body.newMarkers : [];
  const createDistrict = !!body.createDistrict;

  const markers = await readMarkers();
  if (!markers.districts) markers.districts = {};

  if (createDistrict) {
    // Seed a fresh district entry — add a tier-1 marker of the district name itself.
    const seeded = [{ value: district, tier: 1 }, ...newMarkers];
    const existing = markers.districts[district];
    if (existing) {
      // Already exists — treat as merge instead of overwrite to be safe.
      existing.markers = dedupMarkers(existing.markers, seeded);
      if (league && !(existing.leagues || []).includes(league)) {
        existing.leagues = [...(existing.leagues || []), league];
      }
    } else {
      markers.districts[district] = {
        leagues: league ? [league] : [],
        markers: dedupMarkers([], seeded),
      };
    }

    // Also update township field options in the DB so the dropdown sees the new district.
    try {
      // Prefer the existing helper if available — it logs to audit.
      const res = addFieldOption("player", "township", district);
      if (res && res.error) {
        // Fall back to a direct write if the helper rejected it.
        const db = getDb();
        const f = db.prepare("SELECT id, options FROM fields WHERE record_type='player' AND name='township'").get();
        if (f) {
          let opts = [];
          try { opts = f.options ? JSON.parse(f.options) : []; } catch { opts = []; }
          if (!opts.includes(district)) {
            opts.push(district);
            db.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(opts), f.id);
          }
        }
      }
    } catch (e) {
      // Don't blow up the whole save just because the DB update failed.
      console.warn("[markers] failed to update township options:", e?.message || e);
    }
  } else {
    // Append into existing district. If it doesn't exist, create it lazily.
    const existing = markers.districts[district] || { leagues: [], markers: [] };
    existing.markers = dedupMarkers(existing.markers, newMarkers);
    if (league && !(existing.leagues || []).includes(league)) {
      existing.leagues = [...(existing.leagues || []), league];
    }
    markers.districts[district] = existing;
  }

  await writeMarkersAtomic(markers);

  const totalMarkers = (markers.districts[district].markers || []).length;
  return Response.json({ ok: true, district, totalMarkers });
}
