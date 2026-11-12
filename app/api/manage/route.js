// One endpoint for every rename / move / delete / edit on Leagues & Assignment.
// The heavy lifting (and the "walk every place the name is stored" logic)
// lives in lib/manage.js; existing edits (assignment rules, divisions) reuse
// the functions in lib/tools.js that S-Dot already uses.
import { bindRequest } from "@/lib/actor.js";
import {
  choiceUsage, renameChoice, deleteChoice,
  seasonUsage, renameSeason, deleteSeason,
  updateFlag, updateTeamRule, adoptRules, setRuleSeason, removeRuleFromSeason,
} from "@/lib/manage.js";
import { updateAssignmentRule, updateDivision } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  try {
    switch (b.action) {
      // leagues + townships  (b.kind = "league" | "township")
      case "usage":         return Response.json(choiceUsage(b.kind, b.name));
      case "rename":        return Response.json(await renameChoice(b.kind, b.from, b.to));
      case "move":          return Response.json(await renameChoice(b.kind, b.from, b.to, { merge: true }));
      case "delete":        return Response.json(await deleteChoice(b.kind, b.name));
      // seasons
      case "season_usage":  return Response.json(seasonUsage(b.name));
      case "season_rename": return Response.json(await renameSeason(b.from, b.to));
      case "season_move":   return Response.json(await renameSeason(b.from, b.to, { merge: true }));
      case "season_delete": return Response.json(await deleteSeason(b.name));
      // in-place edits
      case "assignment_edit": return Response.json(updateAssignmentRule(b.id, b));
      case "division_edit":   return Response.json(updateDivision(b.id, b));
      case "flag_edit":       return Response.json(updateFlag(b.id, b));
      case "team_rule_edit":  return Response.json(updateTeamRule(b.id, b));
      // assignment rules per season
      case "rules_adopt":     return Response.json(adoptRules(b.ids, b.season));
      case "rule_season":     return Response.json(setRuleSeason(b.id, b.season));
      case "rule_remove":     return Response.json(removeRuleFromSeason(b.id, b.season));
    }
    return Response.json({ error: "unknown action" });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) });
  }
}
