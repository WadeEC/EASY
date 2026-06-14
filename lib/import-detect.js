// Pure detection module — given parsed rows + filename + marker config, guess
// which district a roster spreadsheet belongs to.
//
// Inputs:
//   rows     — array of plain objects (already parsed by xlsx in the client)
//   filename — e.g. "Spring2026_LMK.xlsx"
//   markers  — parsed _imports/markers.json
//
// Output: see README in the route file. Always returns the same shape.

const TIER_WEIGHTS = { 1: 1.0, 2: 0.85, 3: 0.6, 4: 0.7, 5: 0.4 };
const ROW_CAP = 500;        // cap for perf — only inspect first 500 rows
const FILENAME_WEIGHT = 0.5; // synthetic hit weight when filename matches a marker

export function detectDistrict({ rows, filename, markers }) {
  const empty = {
    district: null,
    confidence: 0,
    evidence: [],
    alternates: [],
    suggestedLeague: null,
    suggestedLeagueAlternates: [],
  };

  if (!markers || !markers.districts || typeof markers.districts !== "object") return empty;
  const districts = Object.keys(markers.districts);
  if (!districts.length) return empty;

  const fname = String(filename || "").toLowerCase();
  const sampleRows = Array.isArray(rows) ? rows.slice(0, ROW_CAP) : [];

  // Per-district aggregate: score + map of marker -> {tier, hits, columns:Set}
  const perDistrict = {};
  for (const d of districts) perDistrict[d] = { score: 0, byMarker: new Map() };

  // Helper — record a hit for a marker in a district
  function addHit(district, markerValue, tier, column, count = 1) {
    const bucket = perDistrict[district];
    const weight = TIER_WEIGHTS[tier] ?? 0.3;
    bucket.score += count * weight;
    const key = markerValue;
    let entry = bucket.byMarker.get(key);
    if (!entry) {
      entry = { marker: markerValue, tier, hits: 0, columns: new Set() };
      bucket.byMarker.set(key, entry);
    }
    entry.hits += count;
    if (column) entry.columns.add(column);
  }

  // 1) Filename hint — case-insensitive substring check
  for (const d of districts) {
    const ms = markers.districts[d].markers || [];
    for (const m of ms) {
      const v = String(m.value || "").toLowerCase().trim();
      if (!v) continue;
      if (fname.includes(v)) {
        // Synthetic — pretend it's tier with FILENAME_WEIGHT directly
        perDistrict[d].score += FILENAME_WEIGHT;
        const key = m.value;
        let entry = perDistrict[d].byMarker.get(key);
        if (!entry) {
          entry = { marker: m.value, tier: m.tier || 1, hits: 0, columns: new Set() };
          perDistrict[d].byMarker.set(key, entry);
        }
        entry.hits += 1;
        entry.columns.add("(filename)");
      }
    }
  }

  // 2) Scan cell values — for each row/column, lowercase + trim, then substring check each marker
  for (const row of sampleRows) {
    if (!row || typeof row !== "object") continue;
    for (const col of Object.keys(row)) {
      const raw = row[col];
      if (raw == null) continue;
      const cell = String(raw).toLowerCase().trim();
      if (!cell) continue;
      for (const d of districts) {
        const ms = markers.districts[d].markers || [];
        for (const m of ms) {
          const v = String(m.value || "").toLowerCase().trim();
          if (!v) continue;
          if (cell.includes(v)) {
            addHit(d, m.value, m.tier || 1, col, 1);
          }
        }
      }
    }
  }

  // Compute normalized confidence
  const scored = districts
    .map((d) => ({ district: d, score: perDistrict[d].score }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return empty;

  const top = scored[0];
  const norm = Math.max(top.score, 3);
  const ranked = scored.map((x) => ({
    district: x.district,
    confidence: Math.min(1, x.score / norm),
  }));

  const best = ranked[0];
  const alternates = ranked.slice(1).map((x) => ({ district: x.district, confidence: x.confidence }));

  // Evidence for the top district
  const evidence = [];
  const bucket = perDistrict[best.district];
  // Sort markers by hits desc
  const markerEntries = Array.from(bucket.byMarker.values()).sort((a, b) => b.hits - a.hits);
  for (const e of markerEntries) {
    evidence.push({
      marker: e.marker,
      tier: e.tier,
      hits: e.hits,
      columns: Array.from(e.columns),
    });
  }

  // League suggestion
  const leagues = markers.districts[best.district].leagues || [];
  let suggestedLeague = null;
  let suggestedLeagueAlternates = [];
  if (leagues.length === 1) {
    suggestedLeague = leagues[0];
    suggestedLeagueAlternates = [leagues[0]];
  } else if (leagues.length > 1) {
    suggestedLeague = null;
    suggestedLeagueAlternates = leagues.slice();
  }

  return {
    district: best.district,
    confidence: Number(best.confidence.toFixed(4)),
    evidence,
    alternates,
    suggestedLeague,
    suggestedLeagueAlternates,
  };
}
