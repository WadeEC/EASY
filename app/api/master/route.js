import { readMaster, masterColumns, masterSummary } from "@/lib/tools.js";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

function pickFormat(req, override) {
  const u = new URL(req.url);
  return (override || u.searchParams.get("format") || "json").toLowerCase();
}
function pickType(req, override) {
  const u = new URL(req.url);
  return override || u.searchParams.get("type") || null;
}
function pickDistrict(req, override) {
  const u = new URL(req.url);
  return override || u.searchParams.get("district") || null;
}

function buildRows(rt) {
  const rows = readMaster({ record_type: rt, limit: 50000 });
  const cols = masterColumns(rt);
  const provenance = ["_id", "_source_file", "_source_district", "_source_league", "_status", "_player_id", "_identity_key", "_imported_at", "_imported_by", "_record_type"];
  const header = [...provenance, ...cols];
  const matrix = [header];
  for (const r of rows) {
    const out = [];
    out.push(r.id, r.source_file || "", r.source_district || "", r.source_league || "", r.status || "", r.player_id || "", r.identity_key || "", r.imported_at || "", r.imported_by || "", r.record_type);
    for (const c of cols) {
      const v = r.data[c];
      out.push(v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v));
    }
    matrix.push(out);
  }
  return { rows, cols, header, matrix };
}

function asCsv(matrix) {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  return matrix.map((r) => r.map(esc).join(",")).join("\r\n");
}

function asXlsx(matrix, sheetName = "Master") {
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  // type:"array" returns a Uint8Array we can hand back as a Response body
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return Buffer.from(buf);
}

async function handle(req, body = {}) {
  const rt = pickType(req, body.type);
  const format = pickFormat(req, body.format);

  if (body.action === "summary") {
    return Response.json(masterSummary(rt));
  }

  const built = buildRows(rt);
  if (format === "csv") {
    return new Response(asCsv(built.matrix), { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (format === "xlsx") {
    const buf = asXlsx(built.matrix, rt ? `${rt} master` : "Master");
    return new Response(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="master-${rt || "all"}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json({
    record_type: rt,
    columns: built.cols,
    rows: built.rows,
  });
}

export async function GET(req) { return handle(req); }
export async function POST(req) {
  let b = {}; try { b = await req.json(); } catch {}
  return handle(req, b);
}
