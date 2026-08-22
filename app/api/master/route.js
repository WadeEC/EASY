// The master sheet — every imported row, exactly as it arrived, PER SEASON.
//
// The master sheet is now season-owned: Fall 2026's master is the rows imported
// into Fall 2026, and its column header is the union of columns seen in THAT
// season's uploads. Ask for `season=*` if you really want every season at once
// — and then the season column tells you which is which.
import { readMaster, masterColumns, masterSummary } from "@/lib/tools.js";
import { bindRequest } from "@/lib/actor.js";
import { currentScope, scopeLabel, ALL_SEASONS } from "@/lib/season-scope.js";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

function opts(req, body = {}) {
  const u = new URL(req.url);
  const pick = (k, d = null) => body[k] ?? u.searchParams.get(k) ?? d;
  // `season` defaults to undefined = "use the request scope".
  const seasonParam = pick("season", undefined);
  return {
    type: pick("type"),
    district: pick("district"),
    format: String(pick("format", "json")).toLowerCase(),
    season: seasonParam === null ? undefined : seasonParam,
  };
}

function buildRows(o) {
  const rows = readMaster({ record_type: o.type, district: o.district, season: o.season, limit: 50000 });
  const cols = masterColumns(o.type, o.season);
  // First / last lead the sheet — they're what anyone opening it looks for.
  const provenance = ["_first_name", "_last_name", "_id", "_season", "_source_file", "_source_district",
    "_source_league", "_status", "_player_id", "_identity_key", "_imported_at", "_imported_by", "_record_type"];
  const header = [...provenance, ...cols];
  const matrix = [header];
  for (const r of rows) {
    matrix.push([
      r.first_name || "", r.last_name || "",
      r.id, r.season || "", r.source_file || "", r.source_district || "", r.source_league || "",
      r.status || "", r.player_id || "", r.identity_key || "", r.imported_at || "", r.imported_by || "",
      r.record_type,
      ...cols.map((c) => { const v = r.data[c]; return v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v); }),
    ]);
  }
  return { rows, cols, header, matrix };
}

const asCsv = (matrix) => matrix
  .map((r) => r.map((s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"').join(","))
  .join("\r\n");

function asXlsx(matrix, sheetName = "Master") {
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).replace(/[:\\/?*[\]]/g, "-").slice(0, 31));
  return Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// A filename that names the season, so a downloaded master can't be mistaken
// for another year's.
const safe = (s) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

async function handle(req, body = {}) {
  const o = opts(req, body);
  const label = o.season === undefined ? scopeLabel() : (o.season === ALL_SEASONS ? "all-seasons" : o.season);

  if (body.action === "summary" || o.format === "summary") {
    return Response.json({ scope: label, ...masterSummary(o.type, o.season) });
  }

  const built = buildRows(o);
  const base = `master-${safe(label)}${o.type ? "-" + safe(o.type) : ""}`;

  if (o.format === "csv") {
    return new Response("﻿" + asCsv(built.matrix), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (o.format === "xlsx") {
    const buf = asXlsx(built.matrix, `${label} master`);
    return new Response(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${base}.xlsx"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json({
    season: label,
    record_type: o.type,
    columns: built.cols,
    rows: built.rows,
  });
}

export async function GET(req) {
  bindRequest(req);
  return handle(req);
}
export async function POST(req) {
  bindRequest(req);
  let b = {}; try { b = await req.json(); } catch {}
  return handle(req, b);
}
