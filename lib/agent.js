// The agent loop — hands the backend toolbox to a local or cloud LLM and collects
// proposed changes into a plan the user confirms. Read-only lookups run immediately.
//
// Capabilities (layered in over the original league-data agent):
//   - LLM transport: Ollama -> Groq -> Gemini, auto-fallback (lib/llm.js)
//   - UI manipulation: live CSS/text/layout/theme changes (lib/ui-tools.js)
//   - Meta primitives: plan/warn/suggest/clarify/remember/recall/finish (lib/meta-tools.js)
//   - Code edits: read + propose diff, approval-gated (lib/code-tools.js)
//   - Page awareness: client sends DOM snapshot + activity with each turn
//   - Long-term memory: facts persist across sessions (lib/memory.js)
import { chat as llmChat } from "./llm.js";
import { getDb, getRow, listAudit, undo } from "./db.js";
import * as T from "./tools.js";
import { UI_TOOL_SCHEMAS, UI_TOOL_NAMES, runUiTool } from "./ui-tools.js";
import { META_TOOL_SCHEMAS, META_TOOL_NAMES, runMetaTool, gatherMemoryHints } from "./meta-tools.js";
import { CODE_TOOL_SCHEMAS, CODE_TOOL_NAMES, runCodeTool } from "./code-tools.js";

const MAX_STEPS = 8;

// System prompt is now a builder so we can inject the live page context + recalled facts.
function buildSystem({ pageContext, recalledFacts } = {}) {
  const ctxBlock = pageContext
    ? `\n\n## Live page context (what the user is looking at right now)\n\`\`\`json\n${JSON.stringify(pageContext, null, 2).slice(0, 3500)}\n\`\`\`\n`
    : "";
  const memBlock = recalledFacts?.length
    ? `\n\n## Things you've remembered before\n${recalledFacts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}\n`
    : "";

  return BASE_SYSTEM + ACCURACY_GUIDE + UI_GUIDE + META_GUIDE + CODE_GUIDE + schemaBlock() + ctxBlock + memBlock;
}

// Pulled live from the DB on every turn so the agent can't drift from real schema state.
// Cuts hallucinated field names and invented select values at the source.
function schemaBlock() {
  try {
    const types = T.getRecordTypes();
    if (!types.length) return "";
    const lines = [];
    for (const rt of types) {
      const fields = T.getFields(rt.name);
      if (!fields.length) continue;
      const fls = fields.map((f) => {
        let opts = "";
        if (f.options) { try { const o = JSON.parse(f.options); if (Array.isArray(o) && o.length) opts = ` ∈ {${o.join(", ")}}`; } catch {} }
        return `${f.name}:${f.data_type}${f.required ? "(req)" : ""}${opts}`;
      });
      lines.push(`- ${rt.name} (${rt.label || rt.name}): ${fls.join("; ")}`);
    }
    return `\n\n## Live schema — these are the ONLY valid record types, field names, and select values (case-sensitive). Do not invent.\n${lines.join("\n")}\n`;
  } catch { return ""; }
}

const ACCURACY_GUIDE = `

## Accuracy rules — pair with the audit log + undo

Anti-hallucination guardrails. Every write action you take is recorded with a before/after snapshot in the audit log and can be undone, so being precise is what makes the system trustworthy.

1. Never invent IDs. Before calling update_record / delete_record / set_checkin, call find_records first to resolve a name to a numeric id. If find_records returns 0 matches, tell the user and stop. If it returns >1 match, ask the user which one (call ask_clarification with the options).
2. Never invent field names. The "Live schema" block below lists the exact, case-sensitive names. If a user says "set Jimmy's bday to Jan 1" but the field is called "dob", use "dob".
3. Never invent select-option values. If the user says "Saturday league", check the live options — it might be "Saturday Limerick". If the live options don't include their value, do NOT silently substitute; either ask, or add the option via add_field_option first if they meant to extend.
4. Required fields are required. create_record without a required field will be rejected.
5. If the system rejects your write call with an error, READ the error and fix the args before retrying — don't repeat the same call.
6. When a user asks you to do something destructive (delete a record, drop a field, bulk update), describe what will happen first via warn_user and stop. The user confirms in their next message.
`;

const UI_GUIDE = `

## You can also change the UI live (no rebuild)

You have ui_* tools that change CSS, text, layout, theme, and behavior of the page the user is on RIGHT NOW. The "Live page context" block below lists every visible interactive element with a CSS selector you can target. When the user says "that button" or "this table" — resolve the reference from the elements list + recent activity.

After making a visible change, call ui_highlight on what you changed so the user sees it. For changes that affect many places (theme, density, font), no highlight needed.

Examples:
- "make the header dark blue" → ui_update_style({selector:"header,.header", property:"backgroundColor", value:"#1e3a8a"}) then ui_set_text on header color if needed.
- "hide the schedule tab for now" → ui_hide({selector:"a[href*='schedule'], .tab-schedule"}).
- "use a serif font" → ui_set_font({family:"Georgia, serif"}).
- "make everything tighter" → ui_set_density({density:"compact"}).
- "remember I like dark mode" → ui_set_dark_mode({on:true}) then remember({key:"prefers_dark_mode", value:"true", scope:"user"}).
`;

const META_GUIDE = `

## Think and communicate, don't just mutate

Before doing anything with more than one step, call \`plan\` with a brief step list — the user wants to see your thinking.

If a request will DELETE many things, drop a section, or otherwise be hard to undo: call \`warn_user\` FIRST and STOP. Wait for the user to confirm in their next message before running the destructive tools.

After finishing a task, often call \`suggest\` with 2–3 likely next moves.

Use \`save_preference\` ONLY to remember USER SETTINGS like "Wade likes compact tables" or "season starts Sept 9". NEVER use save_preference or load_preference to answer "how many" or count questions — those ALWAYS go through count_where / breakdown / query_data on the league data.

Counting examples (do NOT use memory tools for these):
- "how many players are in both leagues" → breakdown({record_type:"player", field:"league"}) then answer
- "how many players have no jersey size" → count_where({record_type:"player", field:"jersey_size", op:"empty"})
- "how many coaches do we have" → count_where({record_type:"coach", field:"full_name", op:"not_empty"})

If the request is ambiguous, call \`ask_clarification\` with 2–4 concrete options instead of guessing.

Always end with \`finish\` once the work is done.
`;

const CODE_GUIDE = `

## Code edits (approval-gated)

You CAN read and propose edits to the project source. Use code_read_file / code_search to learn the codebase first. Then code_propose_edit (always pass full new file contents) or code_propose_new_file. These DO NOT auto-apply — they queue with a diff for the user to approve. If a UI change can be done at runtime via ui_*, prefer that over editing source.
`;

const BASE_SYSTEM = `You help a youth flag-football organizer run their LOCAL app. You change the BACKEND by calling tools (sections, fields, rules, records); pages render from it.

DECIDE QUESTION vs CHANGE:
- QUESTION → answer in plain English; no writes. Use count_where / breakdown / list_* for facts.
- CHANGE → call the tools. Use sensible defaults; don't stall enumerating options.
- Ambiguous → answer rather than write.

LOOK BEFORE YOU ASK. Never ask the user what's already in the database. Read tools that answer the obvious questions:
- "how many <type>?" → count_where({record_type, field:"full_name", op:"not_empty"})
- leagues / townships → get_field_options({record_type:"player", field:"league" | "township"})
- divisions → list_divisions()
- rules → list_assignment_rules / list_team_rules / list_flags
- press queue → get_press_queue
- schema → list_schema
Only ask about user-choice things (preferences, names of new things, ambiguous matches).

CREATION TASKS — STEP-WALK MODE. When the user gives a BROAD creation request ("walk me through it", "build a schedule", "add a player", "create a tournament", "add a rule", "rank a team", "add a detail"), ask ONE short question at a time with a smart default in parentheses. Format each question as a single line: "Question? (default: VALUE)". Accept "ok"/"yes"/"sure"/"skip" as "use the default". Skip steps the user already answered. At the end, restate the plan in one sentence and call the tool. Don't dump a multi-field form on them.
- "Build a schedule" — generate_schedule REQUIRES league + start_date + weeks + (fields OR fields_count) + games_per_day + slot_mins + division_start_times. All divisions in a league play the same day; each division has its own first-game time. Step order — do ALL "applies-to-every-league" steps once, then loop the last step per league:
  1. Which league(s)? (list_assignment_rules / get_field_options for options; "all" → loop)
  2. First game date? (default: next Saturday, or load_preference("season_start"))
  3. How many weeks of games? (default: 8) — game weekends only; blackouts are skipped, not counted.
  4. How many games per team each day? (default: 1) — usually 1; tournaments / pool play might run 2.
  5. How long is each game (slot length, in minutes)? (default: 60) — sets the gap between consecutive slot starts. Slot length × games_per_day = the runway each division needs (e.g. 2 games × 60 min = each division needs a 2-hour window before the next division's start time).
  6. How many fields per league? (default: 4 → Field 1–4)
  7. Any weeks to block off? (default: none)
  8. **For EACH league**: ask the per-division first-game times. List the divisions present in THAT league (parse team-name prefixes from scheduleTeams(league)), then ask one short line per division: "Start time for Ages 4–6? (default: 08:00)". You can batch them in a single ask_clarification with the divisions listed plus suggested staggered defaults that respect the slot × games_per_day runway you collected in step 5. If the league has no divisions, ask once for start_time.
  Then call generate_schedule for EACH league with that league's division_start_times: { "<div>": "HH:MM" } + games_per_day + slot_mins. On { error, missing_division_start_times }, ask only the divisions still missing.
- "Build teams" — step order: 1) league? 2) per division? (default yes) 3) target_size? (default 10) 4) confirm — then build_and_save_teams.
- "Add a player" — step order: 1) full name? 2) age? 3) township? (offer get_field_options) 4) league? (or "auto" → leave blank, rules will route) 5) jersey size? (default: ask) 6) parent phone? (optional) — then create_record({type:"player", ...}).
- "Create a tournament" — step order: 1) name? 2) date? (default next Saturday) 3) field(s)? (default 4) 4) teams? — then create the tournament record + games.
- "Add a rule" (assignment rule) — step order: 1) target field? (default league) 2) condition (field + op + value)? 3) set to which value? (offer get_field_options) — then create_assignment_rule.
- "Add a detail" (field on a section) — step order: 1) which section? 2) detail name + label? 3) type? (text/number/date/bool/select) 4) if select, options? — then add_field. Always list_schema first so you don't duplicate an existing detail (addField will refuse aliases anyway, but checking first saves a round-trip).
- "Rank a team" — step order: 1) team? 2) walk through each player asking rank 1-5 (or "skip"). update_record on each.

DECIDE, DON'T STALL. For DIRECT requests with enough info ("build teams of 10", "add Cora Shaw age 9, Limerick"), USE SENSIBLE DEFAULTS and DO IT — don't enumerate every option. Apply configured rules, pick reasonable defaults, run the action, report what you did. The user can adjust afterward — every write is undoable.
- "Generate divisions" → setup_standard_divisions().
- "Reassign players" → reassign_all({record_type:"player"}).

EDIT IN PLACE — never delete+recreate when an update tool exists.
- Rules → list_assignment_rules → update_assignment_rule (or toggle_rule). Other rule kinds: delete_rule + create_*.
- Select choices → remove_field_option / rename_field_option (rename migrates existing records).
- Divisions → update_division (players re-sort).
- Player league/division → move_player (honors locks) or bulk_move_players.
- Games → set_game_score / clear_game_score.
- Schedule → add_blackout / remove_blackout / apply_rainout (preview_rainout first).
- Press → set_press_override.
- Links → create_link / add_link_member / remove_link_member / set_link_reason / delete_link.

Core rules / vocab:
- New section: define_record_type (singular: "coach"), then add_field per detail TO THAT SECTION (never substitute another section).
- Field types: text, number, date, bool, select.
- Townships and leagues are choices on player.township / player.league, NOT separate sections. Use add_field_option / remove_field_option / rename_field_option.
- Assignment rules: create_assignment_rule (e.g. township=="Limerick" → "Saturday Limerick"); auto-apply on add/import.
- Team Builder rules: create_team_rule. types: keep_together (field "__siblings__" or "link_group" or any detail), balance (numeric detail).
- Home flags: create_flag_rule. op: empty / not_empty / == / != / >= / <= / > / <.
- Coaches: setup_coaches (also auto-keeps coach's child on their team).
- Divisions: setup_standard_divisions (ages 4–17) or create_division (one bracket).
- All-stars: set_all_star_cap(max) — Team Builder spreads them evenly.

Acting by name:
- update_record / delete_record / set_checkin require an id. find_records first (caps at 25).
- ALL-RECORDS work → list_records (no cap) then bulk_update_field / sequence_field. Don't loop update_record beyond ~5 records.
- Before add_field, check list_schema + existing labels — addField refuses duplicates by alias.
- count_where / breakdown for "how many" questions; reply with ONE short sentence, no tables / SQL.

PAGE-AWARE QUESTIONS. The user's current page is in the "Live page context" block. Tailor follow-ups to it — and keep them SHORT (single line, 1–3 inline options where useful):
- Build / form pages (schedule build, teambuilder build, division setup) → ask only for the required field that's still blank (e.g. "Which league?" or "How many weeks?"). Don't restate every field.
- Info / list pages (players, coaches, schedule, master spreadsheet, change log) → offer one of: filter, manipulate, or report. Phrase as a 1-line question with concrete options ("Filter to one league, see missing jersey sizes, or bulk update a field?").
- Action pages (attendance, scan-in, board) → ask the one missing piece ("Which week?" or "Which player?").
- Reports / exports → ask scope first ("This league or all? CSV or HTML?").

If you can answer or act with the data you already have, DO IT and skip the question entirely. Every clarifying question costs tokens both ways — only ask when a default would actually be wrong.

Talk like a friendly assistant to a busy parent volunteer. Plain English, no JSON. Say "section" not "record type", "details" not "fields".
These are records about MINORS — never invent real names, ages or phone numbers; ask.`;

// Backward compat for any code that imported SYSTEM directly
export const SYSTEM = BASE_SYSTEM;

const TOOL_SCHEMAS = [
  fn("define_record_type", "Create a new section (e.g. player, team).", { name: ["string", true], label: "string", description: "string" }),
  fn("add_field", "Add a detail to a section. UI updates automatically.", {
    record_type: ["string", true], name: ["string", true],
    data_type: [{ type: "string", enum: T.VALID_TYPES }, true], label: "string", required: "boolean",
    options: { type: "array", items: { type: "string" } },
  }),
  fn("create_rule", "Create a reactive rule.", { name: ["string", true], condition: ["object", true], action: ["object", true] }),
  fn("create_record", "Create a record; put values in 'fields'.", { type: ["string", true], name: "string", fields: "object" }),
  fn("update_record", "Update a record by id.", { id: ["integer", true], fields: ["object", true] }),
  fn("query_data", "Run a read-only SELECT.", { sql: ["string", true] }),
  fn("count_where", "Count records in a section matching one condition (op: empty/not_empty/==/!=/>=/<=/>/<).", {
    record_type: ["string", true], field: ["string", true], op: "string", value: "string",
  }),
  fn("breakdown", "Count records in a section grouped by a detail's values (e.g. players per league).", {
    record_type: ["string", true], field: ["string", true],
  }),
  fn("list_schema", "List sections and their details.", { record_type: "string" }),
  fn("list_rules", "List rules.", { record_type: "string" }),
  fn("rename_record_type", "Rename a section's display name.", { name: ["string", true], new_label: ["string", true] }),
  fn("rename_field", "Rename a field's label.", { record_type: ["string", true], name: ["string", true], new_label: ["string", true] }),
  fn("remove_field", "Remove a field from a section.", { record_type: ["string", true], name: ["string", true] }),
  fn("delete_record_type", "Delete a section (refuses if it has records unless force).", { name: ["string", true], force: "boolean" }),
  fn("add_field_option", "Add one choice to a select detail (creates the detail as a choice field if it doesn't exist yet). For several choices, call once per choice.", { record_type: ["string", true], field: ["string", true], option: ["string", true] }),
  fn("create_assignment_rule", "Route players to a league when features match (e.g. age >= 13 -> Saturday Limerick).", {
    name: ["string", true],
    conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" } } } },
    set_value: ["string", true], set_field: "string", record_type: "string",
  }),
  fn("create_team_rule", "Shape how the Team Builder groups players. type 'keep_together' (field '__siblings__', 'link_group', or a detail name) or 'balance' (a numeric detail like 'age').", {
    type: [{ type: "string", enum: ["keep_together", "balance"] }, true],
    field: ["string", true], label: "string",
  }),
  fn("create_flag_rule", "Add a Home 'At a glance' flag counting records to watch for (e.g. players with no league).", {
    label: ["string", true], record_type: "string", field: ["string", true],
    op: [{ type: "string", enum: T.FLAG_OPS }, true], value: "string",
  }),
  fn("setup_coaches", "Create the standard Coaches section (name, phone, role, child's name). The Team Builder then keeps a coach's child on their team and spreads coaches.", {}),
  fn("generate_schedule", "Build + save schedule for ONE league. REQUIRED: league, start_date, weeks, fields[] OR fields_count, AND division_start_times (object {divisionName: \"HH:MM\"}) — same league day, different start times per division. Single-bracket leagues with no divisions can use start_time instead. Also supports blocked_weeks (1-based), slot_mins. Returns { error, missing, missing_division_start_times } on bad input.", {
    league: "string", start_date: "string", weeks: "integer", games_per_day: "integer",
    fields: { type: "array", items: { type: "string" } },
    fields_count: "integer",
    blocked_weeks: { type: "array", items: { type: "integer" } },
    division_start_times: "object",
    start_time: "string", slot_mins: "integer",
  }),
  fn("create_division", "Add one age-group division (players are auto-sorted into it by age).", {
    name: ["string", true], age_min: ["integer", true], age_max: ["integer", true], league: "string",
  }),
  fn("setup_standard_divisions", "Create a standard set of age divisions covering ages 4–17.", {}),
  fn("set_all_star_cap", "Limit how many all-star players can be on one team (spreads strong players, prevents a super-team). Adds an All-Star detail to players.", {
    max: ["integer", true],
  }),
  fn("find_records", "Find by detail (default full_name); returns up to 25 matches. Call before update/delete by name.", {
    type: ["string", true], query: ["string", true], field: "string", limit: "integer",
  }),
  fn("list_records", "List ALL records of a type (paged, no 25 cap). Use for whole-roster actions.", {
    record_type: ["string", true],
    where: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" } } },
    limit: "integer", offset: "integer", order: "string",
  }),
  fn("bulk_update_field", "Set one field to one value across many records (by ids[] or where).", {
    record_type: ["string", true], field: ["string", true], value: "string",
    ids: { type: "array", items: { type: "integer" } },
    where: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" } } },
  }),
  fn("sequence_field", "Assign sequential values (start,start+step,…) across records in order. Skips already-set unless overwrite.", {
    record_type: ["string", true], field: ["string", true],
    start: "integer", step: "integer", order: "string", overwrite: "boolean",
    ids: { type: "array", items: { type: "integer" } },
    where: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" } } },
  }),
  fn("reassign_all", "Re-apply assignment rules across existing records of a type.", { record_type: "string" }),

  // ---- Rules: edit / toggle / delete ----
  fn("update_assignment_rule", "Edit assignment rule in place (name/conditions/set_field/set_value).", {
    id: ["integer", true], name: "string",
    conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" } } } },
    set_value: "string", set_field: "string",
  }),
  fn("toggle_rule", "Activate/deactivate a rule by id.", { id: ["integer", true], active: ["boolean", true] }),
  fn("delete_rule", "Delete a rule by id (any kind).", { id: ["integer", true] }),

  // ---- Field options ----
  fn("remove_field_option", "Remove one select choice. Refuses if records still use it unless force.", {
    record_type: ["string", true], field: ["string", true], option: ["string", true], force: "boolean",
  }),
  fn("rename_field_option", "Rename one select choice and migrate every record using it.", {
    record_type: ["string", true], field: ["string", true], from: ["string", true], to: ["string", true],
  }),
  fn("get_field_options", "List the choices on a select field.", { record_type: ["string", true], field: ["string", true] }),

  // ---- Divisions ----
  fn("update_division", "Edit division: name/age_min/age_max/league. Re-sorts players.", {
    id: ["integer", true], name: "string", age_min: "integer", age_max: "integer", league: "string",
  }),
  fn("delete_division", "Delete division by id; re-sorts affected players.", { id: ["integer", true] }),
  fn("list_divisions", "List divisions (id, name, age range, league).", {}),

  // ---- Roster moves & league locks ----
  fn("move_player", "Move one player to league/division (honors league locks).", {
    id: ["integer", true], league: "string", second_league: "string", division: "string",
  }),
  fn("bulk_move_players", "Move many players. mode: set replaces, clear empties.", {
    ids: [{ type: "array", items: { type: "integer" } }, true],
    league: "string", division: "string", second_league: "string",
    mode: { type: "string", enum: ["set", "clear"] },
  }),
  fn("set_league_lock", "Lock/unlock a league (blocks roster moves).", { league: ["string", true], locked: ["boolean", true] }),
  fn("list_league_locks", "List locked leagues.", {}),

  // ---- Games / standings / schedule ----
  fn("get_schedule", "Read saved schedule (optionally by league).", { league: "string" }),
  fn("set_game_score", "Set a game's score (home/away/notes).", {
    game_id: ["integer", true], home_score: "integer", away_score: "integer", notes: "string",
  }),
  fn("clear_game_score", "Clear a game's score.", { game_id: ["integer", true] }),
  fn("get_standings", "Standings (W/L, points) for a league.", { league: "string" }),

  // ---- Blackouts / rainouts ----
  fn("add_blackout", "Block a date from scheduling (YYYY-MM-DD). League scopes it.", {
    date: ["string", true], league: "string", reason: "string",
  }),
  fn("remove_blackout", "Delete a blackout by id.", { id: ["integer", true] }),
  fn("list_blackouts", "List blackout dates (optionally by league).", { league: "string" }),
  fn("apply_rainout", "Cascade games on `date` to next-available weeks; adds a blackout.", {
    date: ["string", true], league: "string", reason: "string",
  }),
  fn("preview_rainout", "Preview apply_rainout without saving.", { date: ["string", true], league: "string" }),
  fn("reschedule_date", "Move every game on `from` to `to` (no blackout, no cascade). dry:true previews.", {
    from: ["string", true], to: ["string", true], league: "string", dry: "boolean",
  }),
  fn("prune_cross_division_games", "Delete saved games where the two teams are in different divisions. Idempotent — call once after any legacy schedule cleanup.", { league: "string" }),

  // ---- Press / size overrides ----
  fn("set_press_override", "Press override: 'clear'/'hold'/'' + optional reason.", {
    player_id: ["integer", true], override: "string", reason: "string",
  }),
  fn("get_press_queue", "Press queue buckets (cleared/waiting/hold) with missing criteria.", { league: "string" }),

  // ---- Links (siblings / keep-together) ----
  fn("create_link", "Group players/coaches that should stay together.", {
    kind: ["string", true],
    player_ids: { type: "array", items: { type: "integer" } },
    coach_ids: { type: "array", items: { type: "integer" } },
    reason: "string",
  }),
  fn("add_link_member", "Add member to a link group.", { link_id: ["integer", true], player_id: "integer", coach_id: "integer" }),
  fn("remove_link_member", "Remove member from a link group.", { link_id: ["integer", true], player_id: "integer", coach_id: "integer" }),
  fn("delete_link", "Delete a link group.", { link_id: ["integer", true] }),
  fn("set_link_reason", "Update reason on a link group.", { link_id: ["integer", true], reason: ["string", true] }),
  fn("list_links", "List link groups.", {}),

  // ---- Flags & rule listing ----
  fn("list_flags", "List Home flags + counts.", {}),
  fn("list_assignment_rules", "List assignment rules (id, name, conditions, target).", { record_type: "string" }),
  fn("list_team_rules", "List Team Builder rules.", {}),

  // ---- Team building (autonomous) ----
  fn("build_and_save_teams", "Build + save teams using active rules. target_size defaults to 10. per_division builds each division separately.", {
    league: "string", division: "string",
    target_size: "integer", num_teams: "integer", per_division: "boolean",
  }),
  fn("delete_record", "Delete one record by id.", { type: "string", id: ["integer", true] }),
  fn("setup_referees", "Create standard Referees section.", {}),
  fn("set_checkin", "Mark player present for a week (YYYY-MM-DD Sunday).", {
    player_id: ["integer", true], week: ["string", true], present: ["boolean", true], player_name: "string",
  }),
  // -------- NEW: UI / Meta / Code tool schemas appended --------
  ...UI_TOOL_SCHEMAS,
  ...META_TOOL_SCHEMAS,
  ...CODE_TOOL_SCHEMAS,
];

const DISPATCH = {
  define_record_type: (a) => T.defineRecordType(a.name, a.label, a.description),
  add_field: (a) => T.addField(a.record_type, a.name, a.data_type, a.label, a.required, a.options),
  create_rule: (a) => T.createRule(a.name, a.condition, a.action, a.kind, a.record_type, a.hard),
  create_record: (a) => T.createRecord(a.type, a.fields, a.name),
  update_record: (a) => T.updateRecord(a.id, a.fields),
  query_data: (a) => T.queryData(a.sql),
  count_where: (a) => T.countWhere(a.record_type, a.field, a.op, a.value),
  breakdown: (a) => T.breakdown(a.record_type, a.field),
  list_schema: (a) => T.listSchema(a.record_type),
  list_rules: (a) => T.listRules(a.record_type),
  rename_record_type: (a) => T.renameRecordType(a.name, a.new_label),
  rename_field: (a) => T.renameField(a.record_type, a.name, a.new_label),
  remove_field: (a) => T.removeField(a.record_type, a.name),
  delete_record_type: (a) => T.deleteRecordType(a.name, a.force),
  add_field_option: (a) => T.addFieldOption(a.record_type, a.field, a.option),
  create_assignment_rule: (a) => T.createAssignmentRule(a.name, a.conditions, a.set_value, a.set_field, a.record_type),
  create_team_rule: (a) => T.createTeamRule(a.type, a.field, a.label),
  create_flag_rule: (a) => T.createFlag(a.label, a.record_type, a.field, a.op, a.value),
  setup_coaches: () => T.seedCoaches(),
  generate_schedule: (a) => T.generateSchedule(a.league, {
    startDate: a.start_date, weeks: a.weeks, gamesPerDay: a.games_per_day,
    fields: a.fields, fields_count: a.fields_count, blocked_weeks: a.blocked_weeks,
    startTime: a.start_time, slotMins: a.slot_mins,
    division_start_times: a.division_start_times,
  }),
  create_division: (a) => T.createDivision(a.name, a.league, a.age_min, a.age_max),
  setup_standard_divisions: () => T.seedStandardDivisions(),
  set_all_star_cap: (a) => T.setAllStarCap(a.max),
  find_records: (a) => findRecords(a.type, a.query, a.field, a.limit),
  list_records: (a) => T.listRecords({ record_type: a.record_type, where: a.where, limit: a.limit, offset: a.offset, order: a.order }),
  bulk_update_field: (a) => T.bulkUpdateField({ record_type: a.record_type, field: a.field, value: a.value, ids: a.ids, where: a.where }),
  sequence_field: (a) => T.sequenceField({ record_type: a.record_type, field: a.field, start: a.start, step: a.step, order: a.order, overwrite: a.overwrite, ids: a.ids, where: a.where }),
  reassign_all: (a) => T.reassignAllRecords(a.record_type || "player"),
  update_assignment_rule: (a) => T.updateAssignmentRule(a.id, { name: a.name, conditions: a.conditions, set_value: a.set_value, set_field: a.set_field }),
  toggle_rule: (a) => T.setRuleActive(a.id, !!a.active),
  delete_rule: (a) => T.deleteRule(a.id),
  remove_field_option: (a) => T.removeFieldOption(a.record_type, a.field, a.option, { force: !!a.force }),
  rename_field_option: (a) => T.renameFieldOption(a.record_type, a.field, a.from, a.to),
  get_field_options: (a) => ({ options: T.getFieldOptions(a.record_type, a.field) }),
  update_division: (a) => T.updateDivision(a.id, { name: a.name, age_min: a.age_min, age_max: a.age_max, league: a.league }),
  delete_division: (a) => { const r = T.deleteRecord(a.id); T.reassignDivisions && T.reassignDivisions(); return r; },
  list_divisions: () => ({ divisions: T.getDivisions() }),
  move_player: (a) => T.movePlayer(a.id, { league: a.league, second_league: a.second_league, division: a.division }),
  bulk_move_players: (a) => T.bulkMovePlayers(a.ids || [], { league: a.league, second_league: a.second_league, division: a.division }, a.mode || "set"),
  set_league_lock: (a) => T.setLeagueLock(a.league, !!a.locked),
  list_league_locks: () => ({ locks: T.getLeagueLocks() }),
  get_schedule: (a) => ({ games: T.getSchedule(a.league) }),
  set_game_score: (a) => T.setGameScore(a.game_id, { home_score: a.home_score, away_score: a.away_score, notes: a.notes }),
  clear_game_score: (a) => T.clearGameScore(a.game_id),
  get_standings: (a) => ({ standings: T.getStandings(a.league) }),
  add_blackout: (a) => T.addBlackout(a.date, a.league || null, a.reason || ""),
  remove_blackout: (a) => T.removeBlackout(a.id),
  list_blackouts: (a) => ({ blackouts: T.listBlackouts(a.league) }),
  apply_rainout: (a) => T.applyRainout({ date: a.date, league: a.league || null, reason: a.reason || "Rainout" }),
  preview_rainout: (a) => T.previewRainout({ date: a.date, league: a.league || null }),
  reschedule_date: (a) => T.rescheduleDate({ from: a.from, to: a.to, league: a.league || null, dry: !!a.dry }),
  prune_cross_division_games: (a) => T.pruneCrossDivisionGames(a.league || null),
  set_press_override: (a) => T.setPressOverride(a.player_id, a.override || "", a.reason || ""),
  get_press_queue: (a) => T.getPressQueue(a.league || null),
  create_link: (a) => T.createLink({ kind: a.kind, playerIds: a.player_ids || [], coachIds: a.coach_ids || [], reason: a.reason || "" }),
  add_link_member: (a) => T.addLinkMember(a.link_id, { playerId: a.player_id || null, coachId: a.coach_id || null }),
  remove_link_member: (a) => T.removeLinkMember(a.link_id, { playerId: a.player_id || null, coachId: a.coach_id || null }),
  delete_link: (a) => T.deleteLink(a.link_id),
  set_link_reason: (a) => T.setLinkReason(a.link_id, a.reason),
  list_links: () => ({ links: T.listLinks() }),
  list_flags: () => ({ flags: T.getFlags() }),
  list_assignment_rules: (a) => ({ rules: T.getAssignmentRules(a.record_type || "player") }),
  list_team_rules: () => ({ rules: T.getTeamRules() }),
  build_and_save_teams: (a) => T.buildAndSaveTeams({
    league: a.league || null, division: a.division || null,
    target_size: a.target_size || null, num_teams: a.num_teams || null,
    perDivision: !!a.per_division,
  }),
  delete_record: (a) => T.deleteRecord(a.id),
  setup_referees: () => T.seedReferees(),
  set_checkin: (a) => T.setCheckin(a.player_id, a.player_name || "", a.week, !!a.present),
};

const READ = new Set([
  "query_data", "list_schema", "list_rules", "count_where", "breakdown", "find_records",
  "list_records",
  "get_field_options", "list_divisions", "list_league_locks", "get_schedule", "get_standings",
  "list_blackouts", "preview_rainout", "list_links", "list_flags",
  "list_assignment_rules", "list_team_rules", "get_press_queue",
  // Code reads run immediately (no mutation)
  "code_read_file", "code_list_files", "code_search", "code_list_pending",
]);
const WRITE = new Set(Object.keys(DISPATCH).filter((k) => !READ.has(k)));
const UI = new Set(UI_TOOL_NAMES);
const META = new Set(META_TOOL_NAMES);
const CODE = new Set(CODE_TOOL_NAMES);
const CODE_PROPOSE = new Set(["code_propose_edit", "code_propose_new_file"]);

// runAgent — accepts either the legacy signature runAgent(messages) or the new
// runAgent({ messages, pageContext }) shape. Returns the rich response:
//   { reply, plan, ui_ops, warnings, suggestions, planSteps, clarify, pendingCode, provider }
export async function runAgent(input) {
  const messages = Array.isArray(input) ? input : (input?.messages || []);
  const pageContext = Array.isArray(input) ? null : (input?.pageContext || null);

  // Pull memory hints based on the latest user message
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const recalledFacts = lastUser ? gatherMemoryHints(lastUser.content || "") : [];

  const system = buildSystem({ pageContext, recalledFacts });
  const convo = [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))];

  const plan = [];            // legacy: backend data changes that go through applyPlan
  const ui_ops = [];          // live DOM ops to apply in browser immediately
  const warnings = [];
  const suggestions = [];
  const pendingCode = [];     // queued code edits (id + diff)
  let planSteps = null;       // the AI's own plan output
  let clarify = null;         // ask_clarification result
  let done = false;
  const readTrace = [];
  let lastText = "";
  let provider = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    let resp;
    try {
      resp = await llmChat({ messages: convo, tools: TOOL_SCHEMAS, mode: planSteps ? "fast" : "reason" });
    } catch (e) {
      return {
        reply: `I couldn't reach the AI. Start Ollama (\`ollama serve\` + \`ollama pull qwen2.5:7b\`) or set GROQ_API_KEY. (${e.message || e})`,
        plan: [], ui_ops: [], warnings: [], suggestions: [],
      };
    }
    provider = resp.provider;
    const msg = resp.message || {};
    const content = msg.content || "";
    let calls = msg.tool_calls || [];
    let fromText = false;
    if (!calls.length && content) {
      const parsed = extractCalls(content);
      if (parsed.length) { calls = parsed; fromText = true; }
    }
    if (!calls.length) { lastText = content; break; }

    // Ensure every tool call has an id so the tool_result can reference it
    // (Claude is strict; Ollama doesn't always include ids).
    let nextId = 0;
    const idFor = (tc) => (tc.id ||= `tc_${Date.now().toString(36)}_${nextId++}`);
    if (!fromText) {
      for (const c of calls) idFor(c);
      // Normalize msg.tool_calls to include the same ids before pushing
      if (msg.tool_calls) {
        msg.tool_calls = msg.tool_calls.map((c, i) => ({ ...c, id: calls[i]?.id || idFor(c) }));
      }
      convo.push(msg);
    } else {
      // From-text path: attach ids and build a synthetic assistant message
      const syntheticCalls = calls.map((c) => ({
        id: idFor(c),
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.parameters || c.arguments || {}) },
      }));
      convo.push({ role: "assistant", content, tool_calls: syntheticCalls });
    }

    for (const tc of calls) {
      const name = fromText ? tc.name : tc.function.name;
      let args = fromText ? (tc.parameters || tc.arguments || {}) : tc.function.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      args = args || {};

      let result;

      if (UI.has(name)) {
        // UI changes apply immediately on the client; we capture the op for the response
        const opResult = runUiTool(name, args);
        if (opResult) ui_ops.push(opResult);
        result = { status: "ui_applied", op: name };
      } else if (META.has(name)) {
        const m = runMetaTool(name, args);
        if (m?.kind === "plan") planSteps = m.steps;
        else if (m?.kind === "warning") warnings.push({ message: m.message, severity: m.severity, affected_count: m.affected_count });
        else if (m?.kind === "suggestion") suggestions.push(...(m.items || []));
        else if (m?.kind === "clarify") clarify = { question: m.question, options: m.options };
        else if (m?.kind === "done") done = true;
        result = { status: "ok", kind: m?.kind };
      } else if (CODE.has(name)) {
        // Read-only code tools run immediately; propose tools queue for approval
        try {
          const r = await runCodeTool(name, args);
          if (r?.kind === "code-change") {
            pendingCode.push({ id: r.pending_id, target: r.target, reason: r.reason, diff: r.diff });
            result = { status: "queued_for_approval", id: r.pending_id, target: r.target };
          } else {
            result = r;
            if (READ.has(name)) readTrace.push({ tool: name, args, result: r });
          }
        } catch (e) {
          result = { error: e.message || String(e) };
        }
      } else if (READ.has(name)) {
        result = runTool(name, args, readTrace);
      } else if (WRITE.has(name)) {
        const v = validateWriteArgs(name, args);
        if (v.error) {
          result = { error: v.error };
        } else {
          plan.push({ tool: name, args: v.args, human: describe(name, v.args) });
          result = { status: "planned" };
        }
      } else {
        result = { error: `unknown tool '${name}'` };
      }

      convo.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 3500),
      });
    }

    if (done || clarify) break;
    if (fromText) break;
  }

  const repaired = plan.length ? repairPlan(plan) : [];
  const cleanText = stripJson(lastText).trim();
  let reply = cleanText;

  if (!reply) {
    if (repaired.length) reply = planIntro(repaired);
    else if (ui_ops.length) reply = "Done — see the highlighted change.";
    else if (warnings.length) reply = warnings.map((w) => w.message).join("\n\n");
    else if (clarify) reply = clarify.question;
    else if (pendingCode.length) reply = `Drafted ${pendingCode.length} code change${pendingCode.length === 1 ? "" : "s"} — review and approve below.`;
    else {
      for (let i = readTrace.length - 1; i >= 0; i--) {
        const txt = readResultText(readTrace[i]);
        if (txt) { reply = txt; break; }
      }
    }
  }
  if (!reply) reply = "Okay — nothing needed changing.";

  return {
    reply,
    plan: repaired,
    ui_ops,
    warnings,
    suggestions,
    planSteps,
    clarify,
    pendingCode,
    provider,
  };
}

// If the model proposes adding a field to a section that doesn't exist yet (and isn't being
// created in this same plan), inject a define_record_type for it so the change actually lands.
export function repairPlan(plan) {
  const known = new Set(T.getRecordTypes().map((t) => t.name));
  const out = [];
  for (const it of plan || []) {
    if (it.tool === "define_record_type") { known.add(T.slug(it.args?.name)); out.push(it); continue; }
    if (it.tool === "add_field") {
      const rt = T.slug(it.args?.record_type);
      if (rt && !known.has(rt)) {
        out.push({ tool: "define_record_type", args: { name: rt }, human: describe("define_record_type", { name: rt }) });
        known.add(rt);
      }
    }
    out.push(it);
  }
  return out;
}

export function applyPlan(plan) {
  const a0 = getDb().prepare("SELECT COALESCE(MAX(id),0) m FROM audit_log").get().m;
  const trace = [];
  for (const item of plan || []) runTool(item.tool, item.args || {}, trace);
  const changed = trace.some((t) => !(t.result && t.result.error));
  return { summary: humanize(trace) || "Done — changes applied.", token: changed ? { afterAudit: a0 } : null };
}

export function undoPlan(token) {
  if (!token) return "There's nothing to undo.";
  const rows = getDb().prepare(
    "SELECT id,action,target_table FROM audit_log WHERE id>? AND undone=0 ORDER BY id DESC"
  ).all(token.afterAudit || 0);
  let n = 0;
  for (const a of rows)
    if (["records", "fields", "rules", "record_types"].includes(a.target_table) && ["create", "update", "delete"].includes(a.action))
      if (!undo(a.id).error) n++;
  return `Undone — reversed ${n} change(s).`;
}

// ---------------- helpers ----------------
// Validate a WRITE tool's args against the live schema BEFORE it's added to the plan.
// Returns { ok: true, args: normalized } or { error: "human-readable message" }.
// Errors get fed back to the LLM as the tool_result, so it self-corrects within MAX_STEPS.
// Tries gentle normalization (case-insensitive field names, case-insensitive select options)
// before erroring out, so common typos don't break the loop.
function validateWriteArgs(name, args) {
  args = args || {};
  let types = []; try { types = T.getRecordTypes().map((t) => t.name); } catch {}

  const _checkType = (rt, key = "record_type") => {
    if (!rt) return `Missing "${key}". Known types: ${types.join(", ") || "(none yet — define one first)"}.`;
    if (!types.includes(rt)) {
      const ci = types.find((x) => x.toLowerCase() === String(rt).toLowerCase());
      if (ci) return { norm: ci };
      return `Unknown ${key} "${rt}". Known: ${types.join(", ")}.`;
    }
    return null;
  };

  const _checkFields = (rt, fieldObj) => {
    let valid = []; try { valid = T.getFields(rt); } catch {}
    const validNames = valid.map((f) => f.name);
    const errors = [];
    const out = {};
    for (const [k, v] of Object.entries(fieldObj || {})) {
      let f = valid.find((x) => x.name === k);
      if (!f) {
        const ci = valid.find((x) => x.name.toLowerCase() === String(k).toLowerCase());
        if (ci) f = ci;
        else { errors.push(`unknown field "${k}" on ${rt} (valid: ${validNames.join(", ")})`); continue; }
      }
      const key = f.name;
      // select option check
      if (f.data_type === "select" && f.options && v != null && v !== "") {
        let opts = []; try { opts = JSON.parse(f.options); } catch {}
        if (opts.length && !opts.includes(v)) {
          const ci = opts.find((o) => String(o).toLowerCase() === String(v).toLowerCase());
          if (ci) { out[key] = ci; continue; }
          errors.push(`"${key}" must be one of: ${opts.join(", ")} (got "${v}"). If they meant a new option, add_field_option first.`);
          continue;
        }
      }
      if (f.data_type === "number" && v != null && v !== "" && Number.isNaN(Number(v))) {
        errors.push(`"${key}" must be a number (got "${v}")`); continue;
      }
      out[key] = v;
    }
    return errors.length ? { error: errors.join("; ") + "." } : { ok: true, fields: out };
  };

  const _checkId = (id, expectedType = null) => {
    if (id == null || id === "") return `Missing "id". Call find_records first to get a numeric id for the ${expectedType || "record"} you mean — don't guess.`;
    const n = Number(id);
    if (!Number.isFinite(n)) return `"id" must be a number (got "${id}"). Use find_records to look it up.`;
    let row = null; try { row = getRow("records", n); } catch {}
    if (!row) return `No record with id ${n} exists. Use find_records to look up by name first.`;
    if (expectedType && row.type !== expectedType) return `Record #${n} is a ${row.type}, not a ${expectedType}. find_records again with the right type.`;
    return { row };
  };

  switch (name) {
    case "create_record": {
      const e = _checkType(args.type, "type");
      if (typeof e === "string") return { error: e };
      const rt = e?.norm || args.type;
      const fr = _checkFields(rt, args.fields || {});
      if (fr.error) return { error: fr.error };
      const required = (() => { try { return T.getFields(rt).filter((x) => x.required); } catch { return []; } })();
      const missing = required.filter((x) => fr.fields[x.name] == null || fr.fields[x.name] === "").map((x) => x.label || x.name);
      if (missing.length) return { error: `Required field${missing.length > 1 ? "s" : ""} missing on ${rt}: ${missing.join(", ")}.` };
      return { ok: true, args: { ...args, type: rt, fields: fr.fields } };
    }
    case "update_record": {
      const c = _checkId(args.id);
      if (typeof c === "string") return { error: c };
      const fr = _checkFields(c.row.type, args.fields || {});
      if (fr.error) return { error: fr.error };
      return { ok: true, args: { id: Number(args.id), fields: fr.fields } };
    }
    case "delete_record": {
      const c = _checkId(args.id);
      if (typeof c === "string") return { error: c };
      return { ok: true, args: { id: Number(args.id) } };
    }
    case "set_checkin": {
      const c = _checkId(args.player_id, "player");
      if (typeof c === "string") return { error: c };
      return { ok: true, args: { ...args, player_id: Number(args.player_id) } };
    }
    case "add_field":
    case "remove_field":
    case "rename_field": {
      const e = _checkType(args.record_type);
      if (typeof e === "string") return { error: e };
      const rt = e?.norm || args.record_type;
      return { ok: true, args: { ...args, record_type: rt } };
    }
    case "add_field_option": {
      const e = _checkType(args.record_type);
      if (typeof e === "string") return { error: e };
      const rt = e?.norm || args.record_type;
      let f = null; try { f = T.getFields(rt).find((x) => x.name === args.field); } catch {}
      if (!f) {
        const all = (() => { try { return T.getFields(rt).map((x) => x.name); } catch { return []; } })();
        return { error: `Unknown field "${args.field}" on ${rt}. Valid: ${all.join(", ")}.` };
      }
      if (f.data_type !== "select") return { error: `Field "${args.field}" is type ${f.data_type}, not select — options don't apply.` };
      return { ok: true, args: { ...args, record_type: rt } };
    }
    default:
      return { ok: true, args };
  }
}

function runTool(name, args, trace) {
  let result;
  try { result = DISPATCH[name] ? DISPATCH[name](args) : { error: `unknown tool '${name}'` }; }
  catch (e) { result = { error: `${name} failed: ${e.message || e}` }; }
  trace.push({ tool: name, args, result });
  return result;
}

function describe(name, a) {
  const f = a.fields || {};
  switch (name) {
    case "define_record_type": return `Create a new section: **${a.label || a.name}**`;
    case "add_field": return `Add a detail **${a.label || a.name}** to **${a.record_type}**`;
    case "create_rule": return `Add a rule: **${a.name}**`;
    case "create_record": return `Add a ${a.type}: **${a.name || f.full_name || f.name || "new record"}**`;
    case "update_record": return `Update ${a.type || "a record"} #${a.id}`;
    case "rename_record_type": return `Rename a section to **${a.new_label}**`;
    case "rename_field": return `Rename a field to **${a.new_label}**`;
    case "remove_field": return `Remove **${a.name}** from **${a.record_type}**`;
    case "delete_record_type": return `Delete the **${a.name}** section`;
    case "add_field_option": return `Add the choice **${a.option}** to **${a.field}**`;
    case "create_assignment_rule": return `Add a league rule: **${a.name}** → ${a.set_value}`;
    case "create_team_rule": return `Add a team-building rule: **${a.label || teamRuleName(a)}**`;
    case "create_flag_rule": return `Add a Home flag: **${a.label}**`;
    case "setup_coaches": return `Set up a **Coaches** section`;
    case "generate_schedule": return `Build a season schedule${a.league ? ` for **${a.league}**` : ""}`;
    case "create_division": return `Add a division: **${a.name}** (ages ${a.age_min}–${a.age_max})`;
    case "setup_standard_divisions": return `Set up standard age divisions (4–17)`;
    case "set_all_star_cap": return `Limit all-stars to **${a.max}** per team`;
    case "delete_record": return `Delete ${a.type ? a.type + " " : ""}record #${a.id}`;
    case "setup_referees": return `Set up a **Referees** section`;
    case "set_checkin": return `${a.present ? "Check in" : "Clear check-in for"} ${a.player_name || ("player #" + a.player_id)} (${a.week})`;
    default: return name;
  }
}

function teamRuleName(a) {
  const field = a.field === "__siblings__" ? "siblings" : a.field;
  return a.type === "balance" ? `Balance by ${field}` : `Keep together: ${field}`;
}

function planIntro(plan) {
  return `Done — applied your ${plan.length !== 1 ? "changes" : "change"}. Use Undo below if you want to revert.`;
}

function joinHuman(parts) {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
}

function humanize(trace) {
  const typesMade = [], byType = {}, rules = [], records = [], changes = [], errors = [];
  for (const t of trace) {
    const { result: r, tool, args: a } = t;
    if (r && r.error) { errors.push(r.error); continue; }
    if (tool === "define_record_type") typesMade.push(a.label || a.name);
    else if (tool === "add_field") (byType[a.record_type] = byType[a.record_type] || []).push(a.label || a.name);
    else if (tool === "create_rule") rules.push(a.name);
    else if (tool === "create_record") records.push(a.type);
    else if (tool === "rename_record_type") changes.push(`renamed a section to **${a.new_label}**`);
    else if (tool === "rename_field") changes.push(`renamed a field to **${a.new_label}**`);
    else if (tool === "remove_field") changes.push(`removed **${a.name}** from **${a.record_type}**`);
    else if (tool === "delete_record_type") changes.push(`removed the **${a.name}** section`);
    else if (tool === "add_field_option") changes.push(`added **${a.option}** to **${a.field}**`);
    else if (tool === "create_assignment_rule") changes.push(`added a league rule (**${a.name}**)`);
    else if (tool === "create_team_rule") changes.push(`added a team-building rule (**${a.label || teamRuleName(a)}**)`);
    else if (tool === "create_flag_rule") changes.push(`added a Home flag (**${a.label}**)`);
    else if (tool === "setup_coaches") changes.push(`set up a **Coaches** section`);
    else if (tool === "generate_schedule") changes.push(`built a season schedule${a.league ? ` for **${a.league}**` : ""}`);
    else if (tool === "create_division") changes.push(`added the **${a.name}** division`);
    else if (tool === "setup_standard_divisions") changes.push(`set up standard age divisions (4–17)`);
    else if (tool === "set_all_star_cap") changes.push(`limited all-stars to **${a.max}** per team`);
    else if (tool === "delete_record") changes.push(`deleted ${a.type || "a"} record #${a.id}`);
    else if (tool === "setup_referees") changes.push(`set up a **Referees** section`);
    else if (tool === "set_checkin") changes.push(`${a.present ? "checked in" : "cleared check-in for"} **${a.player_name || ("player #" + a.player_id)}**`);
  }
  const parts = [];
  for (const ty of [...new Set(typesMade)]) {
    const key = (ty || "").toLowerCase();
    const flds = byType[ty] || byType[key] || [];
    parts.push(`set up a **${ty}** section` + (flds.length ? ` with ${joinHuman(flds)}` : ""));
  }
  for (const [k, v] of Object.entries(byType))
    if (!typesMade.some((m) => (m || "").toLowerCase() === k) && v.length) parts.push(`added ${joinHuman(v)} to **${k}**`);
  for (const rn of rules) parts.push(`added a rule to *${(rn || "").toLowerCase()}*`);
  if (records.length) {
    const counts = {};
    for (const ty of records) counts[ty] = (counts[ty] || 0) + 1;
    for (const [ty, c] of Object.entries(counts)) parts.push(`added ${c} ${ty} record(s)`);
  }
  parts.push(...changes);
  if (!parts.length && !errors.length) return null;
  let msg = parts.length ? `All set! I ${joinHuman(parts)}. You'll see the changes in the menu.` : "";
  if (errors.length) {
    const lead = parts.length ? "A few things didn't go through: " : "I couldn't make those changes: ";
    msg += (msg ? "\n\n" : "") + lead + errors.slice(0, 4).join("; ");
  }
  return msg;
}

function readResultText(t) {
  const r = (t && t.result) || {};
  if (t.tool === "count_where") return `That's **${r.count}** out of ${r.total}.`;
  if (t.tool === "breakdown") {
    if (!r.groups || !r.groups.length) return "There's nothing to break down yet.";
    return "Here's the breakdown:\n\n" + r.groups.map((g) => `- ${g.value}: **${g.count}**`).join("\n");
  }
  if (t.tool === "query_data" && r.rows) return rowsToText(r.rows);
  if (t.tool === "find_records") {
    if (!r.matches || !r.matches.length) return "I couldn't find anything matching that.";
    if (r.matches.length === 1) return `Found it — ${r.matches[0].name} (#${r.matches[0].id}).`;
    return "Here's what I found:\n\n" + r.matches.slice(0, 25).map((m) => `- ${m.name} (#${m.id})`).join("\n");
  }
  return null;
}

// Small helper that the AI calls to look up a record by a detail value.
// Always returns { matches: [{id, name, data}] } so it's cheap for the model to chain into
// update_record / delete_record / set_checkin without hallucinating ids.
function findRecords(type, query, field, limit) {
  const t = T.slug(type || "");
  if (!t) return { error: "type is required" };
  const f = (field || "full_name").trim();
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { error: "query is required" };
  const lim = Math.max(1, Math.min(Number(limit) || 25, 100));
  const rows = T.getRecords(t);
  const out = [];
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    const v = d[f];
    if (v == null) continue;
    if (String(v).toLowerCase().includes(q)) {
      out.push({ id: r.id, name: r.name || d.full_name || d.name || String(v), data: d });
      if (out.length >= lim) break;
    }
  }
  return { matches: out, total: out.length };
}

function rowsToText(rows) {
  if (!rows || !rows.length) return "I didn't find anything matching that.";
  if (rows.length === 1 && Object.keys(rows[0]).length === 1) return `The answer is **${Object.values(rows[0])[0]}**.`;
  const lines = rows.slice(0, 25).map((r) => "- " + Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(", "));
  return "Here's what I found:\n\n" + lines.join("\n") + (rows.length > 25 ? `\n\n…and ${rows.length - 25} more.` : "");
}

function braceGroups(text) {
  const groups = []; let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      let depth = 0, j = i, inStr = false, esc = false;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = !inStr;
        else if (!inStr) { if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { groups.push([i, j + 1]); break; } } }
      }
      i = j + 1;
    } else i++;
  }
  return groups;
}
function extractCalls(text) {
  const calls = [];
  for (const [s, e] of braceGroups(text)) {
    try { const o = JSON.parse(text.slice(s, e)); if (o && o.name && (o.parameters || o.arguments)) calls.push(o); } catch {}
  }
  return calls;
}
function stripJson(text) {
  let out = text || "";
  const g = braceGroups(text || "");
  for (let i = g.length - 1; i >= 0; i--) { const [s, e] = g[i]; try { JSON.parse(text.slice(s, e)); out = out.slice(0, s) + out.slice(e); } catch {} }
  return out;
}

// tiny helper to build Ollama tool schema entries
function fn(name, description, props) {
  const properties = {}, required = [];
  for (const [k, spec] of Object.entries(props)) {
    if (Array.isArray(spec)) {
      const [type, req] = spec;
      properties[k] = typeof type === "string" ? { type } : type;
      if (req) required.push(k);
    } else if (typeof spec === "string") properties[k] = { type: spec };
    else properties[k] = spec;
  }
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
