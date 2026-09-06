import { tidyWhitespace, resyncDisplayNames, fixFieldClashes } from "@/lib/tools.js";
import { bindRequest, getActor } from "@/lib/actor.js";
import { setScope, ALL_SEASONS } from "@/lib/season-scope.js";

export const dynamic = "force-dynamic";

// Maintenance actions that repair existing data.
//
// "tidy" strips stray spacing from every record's display name and text values.
// Imported spreadsheets carry it ("Connor  Johnson", "Ages 13-14 "), and any page
// that scopes by an exact value — the Team Editor's league + division filter is the
// one people notice — silently hides those records. isKnownDivision normalizes
// spacing when it COMPARES, so a padded division passes validation and is then
// stored padded; this cleans up what's already stored.
//
// "resync_names" repairs renames made before updateRecord kept records.name in step
// with full_name — the reason an old coach name lingered on the links screen.
//
// These sweep the whole database rather than one season, so the scope is widened to
// ALL_SEASONS for the call. Records in a LOCKED season are skipped by the tools
// themselves and reported as skippedLocked — a finished season stays as it was.
// Every write is audited: the Change Log lists it and Time Machine reverts the batch.
export async function POST(req) {
  bindRequest(req);
  const b = await req.json().catch(() => ({}));
  setScope(ALL_SEASONS);

  if (b.action === "tidy_preview") return Response.json(tidyWhitespace({ dryRun: true, type: b.type || null }));
  if (b.action === "tidy") return Response.json(tidyWhitespace({ dryRun: false, type: b.type || null, actor: `${getActor()} (cleanup)` }));

  if (b.action === "resync_preview") return Response.json(resyncDisplayNames({ dryRun: true, type: b.type || null }));
  if (b.action === "resync") return Response.json(resyncDisplayNames({ dryRun: false, type: b.type || null, actor: `${getActor()} (cleanup)` }));

  // "fields" re-lays the field each saved game sits on so two divisions stop
  // sharing one field at one time — times, matchups, refs and scores untouched.
  // fields_count raises the pool beyond what the schedule already uses.
  if (b.action === "fields_preview") return Response.json(fixFieldClashes({ dryRun: true, league: b.league || null, fieldsCount: b.fields_count || null }));
  if (b.action === "fields") return Response.json(fixFieldClashes({ dryRun: false, league: b.league || null, fieldsCount: b.fields_count || null, actor: `${getActor()} (cleanup)` }));

  return Response.json({ error: "unknown action" });
}
