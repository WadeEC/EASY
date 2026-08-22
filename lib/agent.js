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

import * as SC from "./season-scope.js";
import * as SEASONS from "./seasons.js";
import * as EXPORTS from "./export.js";

const MAX_STEPS = 8;

// System prompt is now a builder so we can inject the live page context + recalled facts.
function buildSystem({ pageContext, recalledFacts } = {}) {
  const seasonBlock = scopeBlock();
  const ctxBlock = pageContext ? contextBlock(pageContext) : "";
  const memBlock = recalledFacts?.length
    ? `\n\n## Things you've remembered before\n${recalledFacts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}\n`
    : "";

  return BASE_SYSTEM + ACCURACY_GUIDE + NAMES_GUIDE + BULK_GUIDE + DIVISION_GUIDE + SEASON_GUIDE + SCHEDULE_GUIDE + ATTENDANCE_GUIDE + UI_GUIDE + META_GUIDE + CODE_GUIDE
       + schemaBlock() + seasonBlock + ctxBlock + memBlock;
}

// The page context is a MAP OF THE SCREEN for the UI tools — which buttons and
// fields exist and how to target them. It is not data.
//
// It used to be stringified whole and chopped at 3500 characters, which left a
// truncated blob of whatever happened to be rendered — including player names.
// Asked to delete every player in a league, the model counted the names it
// could see rather than asking the database, and offered to delete 14 of 302.
//
// So: the element list is budgeted BEFORE stringifying (so the JSON is always
// valid and says how much it left out), row-ish text is trimmed hard, and the
// block is labelled for what it is.
function contextBlock(pageContext) {
  const MAX_ELEMENTS = 60;
  const ctx = { ...pageContext };
  const all = Array.isArray(ctx.elements) ? ctx.elements : [];
  // Keep the things you can act on. A table row is not one of them.
  const actionable = all.filter((e) => ["a", "button", "input", "select", "textarea", "h1", "h2", "nav"].includes(e.tag) || e.role === "button");
  const kept = (actionable.length ? actionable : all).slice(0, MAX_ELEMENTS).map((e) => ({
    tag: e.tag, sel: e.sel, text: String(e.text || "").slice(0, 40), name: e.name || undefined, visible: e.visible,
  }));
  ctx.elements = kept;
  ctx.elements_shown = kept.length;
  ctx.elements_on_page = all.length;
  ctx.truncated = all.length > kept.length;
  delete ctx.recent_activity;

  return `\n\n## The screen right now — a MAP, NOT DATA\n` +
    `This lists ${kept.length} of ${all.length} on-screen elements so the UI tools can target them.\n` +
    `It is a partial, truncated view of one scrolled page.\n` +
    `NEVER count these, total them, or read record values out of them. Any number about the\n` +
    `league — how many players, how many teams, how many anything — comes from count_matching,\n` +
    `count_where or list_records, never from this block.\n` +
    `\`\`\`json\n${JSON.stringify(ctx, null, 1).slice(0, 3000)}\n\`\`\`\n`;
}

// The season the user is looking at, and the real per-season counts, pulled
// live from the database on every single turn.
//
// This block is the fix for the class of wrong answer where the assistant said
// something true of the database but false of the season on screen ("we have
// 718 players" when this season has 304). The numbers below are read, not
// remembered — the model is told to quote these and nothing else.
function scopeBlock() {
  try {
    const sc = SC.currentScope();
    const label = SC.scopeLabel();
    const info = SEASONS.listSeasons();
    const lines = info.detail.map((s) => {
      const bits = Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ") || "empty";
      const state = s.locked ? " [LOCKED — read only]" : (s.status === "archived" ? " [archived]" : "");
      return `- ${s.name}${s.is_active ? " (active)" : ""}${state}: ${bits}; leagues: ${s.leagues.join(", ") || "none set"}`;
    });
    if (info.untagged) lines.push(`- ${SC.NO_SEASON}: ${info.untagged} legacy players with no season tag`);

    let scopeLine;
    if (sc.mode === "all") {
      scopeLine = "EVERY SEASON AT ONCE. Any number you give covers all seasons — say so explicitly in your answer.";
    } else if (sc.mode === "none") {
      scopeLine = `the ${SC.NO_SEASON} bucket — legacy records that were never tagged with a season.`;
    } else {
      scopeLine = `"${label}". Every read tool you call returns ONLY ${label} data.`;
    }

    return `\n\n## The season on screen right now\nThe user is looking at: ${scopeLine}\n` +
           `\nEvery season in the system:\n${lines.join("\n")}\n`;
  } catch { return ""; }
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
7. NEVER STATE A NUMBER YOU DID NOT JUST READ. Counts, roster sizes, team
   counts, how many are missing a jersey size — all of it comes from a tool
   call in THIS turn (count_where, breakdown, list_records, list_seasons,
   unassigned_report). Not from the conversation, not from the page context,
   not from what was true a moment ago. If you have not called a tool for a
   figure, you do not have that figure: call one, or say you need to check.
8. NEVER INVENT A PERSON. Names, ages and phone numbers come from
   find_records / list_records. If a search returns nothing, the honest answer
   is "I can't find anyone by that name in <season>" — offer to widen to all
   seasons, do not produce a plausible-looking record.
9. REPORT WHAT ACTUALLY HAPPENED. After a write, read the result object. If it
   contains an error, tell the user the error verbatim in plain English and do
   not describe the change as done. If it says 304 enrolled and 12 skipped, say
   both numbers — the skipped ones are the part they need to act on.
10. WHEN YOU DO NOT KNOW, SAY SO. "I'm not sure — here's how we could check" is
   always a better answer than a confident guess. There is no credit for
   sounding certain.
`;

const SEASON_GUIDE = `

## Seasons — the rule that matters most

Each season owns its own players, coaches, teams, divisions, games, attendance,
roster locks and master sheet. They are separate sets of records, not filters
over one pile.

1. EVERY read tool you call is already scoped to the season on screen. So the
   number you get back IS this season's number. Do not add, subtract or
   reconcile it against anything you remember.
2. SAY WHICH SEASON. Any answer containing a count, a roster, a team, a
   schedule or a standing names the season it is about: "Fall 2026 has 304
   players", never "we have 304 players". If the user is on "All seasons", say
   that instead.
3. ANOTHER SEASON'S NUMBERS come from list_seasons (per-season counts) or from
   passing that season by name to a tool that takes one. Never estimate one
   season's figure from another's.
4. MOVING PEOPLE BETWEEN SEASONS is enrollment, not a move. move_player cannot
   change a season and will refuse. Use enroll_players_in_season: it creates a
   NEW record in the target season, leaves last season's roster untouched, and
   drops the player into the target season's Unassigned. Run it with
   dry_run: true first, tell the user the count, and let them confirm.
5. A LOCKED season is read-only. If a write comes back "…is locked", relay that
   — do not try to work around it.
6. UNASSIGNED means one of three specific things in the season on screen:
   no league, no division, or no team. unassigned_report gives all three. Never
   answer "unassigned" as a single blurry number.
`;

const SCHEDULE_GUIDE = `

## Editing a schedule

Pick the tool that matches the size of the change. Going bigger than the ask is
how a one-game fix turns into a rebuilt season.

| They want | Use |
|---|---|
| one game moved, re-fielded, re-reffed | find_games → edit_game |
| a score | find_games → set_game_score (or clear_game_score) |
| a make-up game added | add_game |
| one game cancelled | find_games → delete_game |
| every game on a date moved | reschedule_date (dry:true first) |
| a washed-out date pushed with everything after it | preview_rainout → apply_rainout |
| a date blocked off | add_blackout |
| the whole thing built from scratch | generate_schedule |

ALWAYS find_games first. Game ids are never guessable, and "Team 3's game" is
usually several games — if find_games returns more than one, list them with
dates and times and ask which, rather than picking.

generate_schedule REBUILDS. Never reach for it to fix one game, and never
without saying plainly that it replaces the saved schedule.

edit_game refuses a blacked-out date and a locked season, and refuses fields it
doesn't own. Relay those refusals as they come back — do not retry around them.
`;

const NAMES_GUIDE = `

## Names people say vs names the league uses

People shorten things. "Upper Merion" is the league **Sunday Upper Merion**.
"9-10" is the division **Ages 9-10**. "Limerick" is **Saturday Limerick**.

You do NOT have to guess: move_player, bulk_move_players and create_record
resolve what you pass against the real list. An unambiguous shorthand is
matched and the result tells you what it was taken to mean — pass that on:
"Moved Caden to Sunday Upper Merion (you said Upper Merion)."

If the tool comes back with:
- **ambiguous** — two leagues match. Ask which, quoting both. Do not pick one.
- **unknown** — no league by that name. The error lists the real ones. Say
  what exists and ask; NEVER create a league by writing a new value into the
  field. An invented league shows up in no filter and takes the player off
  every roster they were on.

Before quoting league or division names to the user, get them from
list_divisions / list_schema rather than from memory or from the screen.

When the user corrects you — "no, I meant Sunday Upper Merion" — redo the move
with the corrected name and confirm the player's actual state afterwards with
find_records, rather than assuming the first attempt left them where you
thought.
`;

const DIVISION_GUIDE = `

## Divisions are age ranges, and teams don't get rebuilt

A DIVISION is a bracket someone defined — "Ages 9-10", age_min 9, age_max 10.
A player is in it because their AGE falls in that range. "10" is an age, not a
division. If the roster looks like it's grouped by bare ages, the division
field has junk in it from an upload: say so and offer sort_into_divisions.

list_divisions shows the brackets and their ranges. If a season has none, no
amount of re-sorting will help — the answer is to create them
(create_division / seed the standard set), and say that plainly.

### Someone registered after the teams were built

This is the common one, and the wrong answer is to rebuild. Rebuilding starts
from scratch and reshuffles every roster — parents already know their team.

Right answer, in order:
  1. count_matching({record_type:"player", field:"team", op:"empty", league})
     — how many are actually waiting.
  2. preview_place_on_teams({league}) — shows who lands where and the resulting
     sizes, changes nothing.
  3. Tell the user the plan: the number, the teams that grow, and that nobody
     already on a team moves.
  4. place_on_teams({league}) once they say yes.

It fills the smallest team first, keeps a player in their own division, and
keeps link groups (siblings, carpools) with the player they're linked to. A
player whose division has no team at all is reported as skipped, not forced
onto a wrong-age team — pass that on rather than hiding it.

Only reach for build_teams / the Team Builder when the user actually wants the
rosters redone from scratch, and warn them that it moves everyone.
`;

const BULK_GUIDE = `

## Bulk changes, and where numbers come from

EVERY number you say about the data comes from a tool call in this turn. The
"screen right now" block is a map of buttons for the UI tools — it shows one
scrolled page, truncated. Counting it is how "302 players" becomes "14".

Before any bulk change, and before quoting any total:
  count_matching({record_type, league}) → the real number, from the database.

### Deleting a lot at once
1. count_matching → get the real number.
2. Tell the user that number, name what will go, and say it can be restored
   from Time Machine.
3. bulk_delete_records with expect_count set to EXACTLY the number you quoted.

The delete re-counts and refuses if it doesn't match what you were told. If it
comes back "Count mismatch", do not retry with the new number on your own —
tell the user the count changed and what it is now.

"Delete every player in Saturday Limerick" → count_matching({record_type:"player",
league:"Saturday Limerick"}), then bulk_delete_records with that count.

"Clear out Saturday Limerick" (everything, not just players) →
count_league_contents, then clear_league with its total.

### Changing a lot at once (not deleting)
- One field across many: bulk_update_field.
- League / division / team: bulk_move_players.
- Into another season: enroll_players_in_season (copies forward, dry_run first).
- Numbering: sequence_field.

All of them report what was refused as well as what worked. Say both numbers.

### Never
- Never loop update_record or delete_record over more than ~5 records — there
  is a bulk tool for it.
- Never delete as a way of "moving" someone. Moving is move_player; moving to
  another season is enroll_players_in_season.
- Never soften a deletion. Say "permanently delete 302 players", with the count.
`;

const ATTENDANCE_GUIDE = `

## Attendance

Attendance is per week, keyed by the SUNDAY that starts the week (YYYY-MM-DD).
Call attendance_weeks if you don't know which weeks exist — don't invent a date.

Four states, and they are not the same:
- **present** — they were here
- **absent** — attendance was taken and they weren't
- **excused** — away, told us in advance
- **not taken** — nobody marked them at all

Never report "not taken" as absent. "12 absent" and "12 we never marked" send a
coach to do two completely different things.

Read attendance_week before answering any "who was here / who's missed the most"
question — the numbers come from that call, not from memory. To mark a lot of
people at once use save_attendance_week; for one person use set_checkin.

Every check-in door writes the same records — the Team Board, the kiosk
scanner, the referee kiosk, the Attendance page and you. A player scanned in at
the gate is already present here; do not mark them again.
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
  fn("move_player", "Move one player between league / division / team WITHIN the season on screen. Honors roster locks. Cannot change a season — use enroll_players_in_season for that.", {
    id: ["integer", true], league: "string", second_league: "string", division: "string", team: "string",
  }),
  fn("bulk_move_players", "Move many players within this season. mode: set replaces, clear empties.", {
    ids: [{ type: "array", items: { type: "integer" } }, true],
    league: "string", division: "string", second_league: "string", team: "string",
    mode: { type: "string", enum: ["set", "clear"] },
  }),
  fn("set_league_lock", "Lock/unlock a league (blocks roster moves).", { league: ["string", true], locked: ["boolean", true] }),
  fn("list_league_locks", "List locked leagues.", {}),

  // ---- Games / standings / schedule ----
  fn("get_schedule", "Read saved schedule (optionally by league).", { league: "string" }),
  fn("find_games", "Search this season's saved schedule the way a person describes it — by team, date, week, field or league. Returns game ids. Call this before edit_game; never guess a game id.", {
    league: "string", team: "string", date: "string", week: "integer", field: "string", limit: "integer",
  }),
  fn("edit_game", "Change ONE saved game: date, time, field, teams, referee or week. Only the values you pass are changed. Refuses a blacked-out date and a locked season. Use set_game_score for scores, reschedule_date to move a whole date, apply_rainout to cascade.", {
    game_id: ["integer", true], date: "string", time: "string", field: "string",
    home_team: "string", away_team: "string", referee: "string", week: "integer",
  }),
  fn("add_game", "Add one game to the saved schedule (a make-up game, say) without rebuilding it.", {
    league: ["string", true], date: ["string", true], home_team: ["string", true], away_team: ["string", true],
    time: "string", field: "string", week: "integer", referee: "string",
  }),
  fn("delete_game", "Remove one game from the saved schedule.", { game_id: ["integer", true] }),
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
  fn("set_checkin", "Mark one player for a week (YYYY-MM-DD Sunday). status: present / absent / excused / clear. 'clear' means attendance was never taken for them — different from absent.", {
    player_id: ["integer", true], week: ["string", true],
    status: { type: "string", enum: ["present", "absent", "excused", "clear"] },
    present: "boolean", player_name: "string", note: "string",
  }),
  fn("attendance_week", "One week's sheet: everyone on the roster with present / absent / excused / not-taken, plus who marked it. Read this before answering any 'who was here' question.", {
    week: ["string", true], league: "string", division: "string", team: "string",
  }),
  fn("attendance_weeks", "The weeks this season has (from the schedule, plus any already marked).", { league: "string" }),
  fn("save_attendance_week", "Mark many players for one week at once. entries: [{id, status, note}]. Reports what was refused.", {
    week: ["string", true],
    entries: [{ type: "array", items: { type: "object", properties: { id: { type: "integer" }, status: { type: "string" }, note: { type: "string" } } } }, true],
  }),
  // ---- Late arrivals, divisions ----
  fn("preview_place_on_teams", "PREVIEW seating players who have no team onto the teams that ALREADY EXIST — for players who registered after the teams were built. Shows who goes where and the resulting roster sizes. Changes nothing. Never moves a player who already has a team.", {
    league: "string", division: "string", max_size: "integer",
    ids: { type: "array", items: { type: "integer" } },
  }),
  fn("place_on_teams", "Seat players who have no team onto the teams that ALREADY EXIST, filling the smallest first and keeping link groups together. Does NOT rebuild the teams and does NOT move anyone who already has a team. Call preview_place_on_teams first and tell the user the plan.", {
    league: "string", division: "string", max_size: "integer",
    ids: { type: "array", items: { type: "integer" } }, reason: "string",
  }),
  fn("sort_into_divisions", "Re-sort every player in this season into the age bracket their age falls into, and clear the ones that match no bracket. Use when divisions look wrong — e.g. the roster is grouped by bare ages instead of brackets.", {}),

  // ---- Bulk: count, delete, clear ----
  fn("count_matching", "COUNT FROM THE DATABASE. How many records match a league / division / team / field condition in the season on screen. Call this before saying any number, and always before a bulk change — the screen shows one scrolled page, not the total.", {
    record_type: "string", league: "string", division: "string", team: "string",
    field: "string", op: { type: "string", enum: ["==", "!=", ">=", "<=", ">", "<", "empty", "not_empty"] }, value: "string",
    ids: { type: "array", items: { type: "integer" } },
  }),
  fn("bulk_delete_records", "PERMANENTLY DELETE many records at once (e.g. every player in a league). You MUST call count_matching first and pass its number as expect_count — the delete re-counts and refuses if the two disagree. Audited per record and restorable from Time Machine.", {
    record_type: ["string", true],
    expect_count: ["integer", true],
    league: "string", division: "string", team: "string",
    field: "string", op: "string", value: "string",
    ids: { type: "array", items: { type: "integer" } },
    reason: "string",
  }),
  fn("count_league_contents", "What one league holds in the season on screen, per record type. Use before clear_league.", {
    league: ["string", true], types: { type: "array", items: { type: "string" } },
  }),
  fn("clear_league", "PERMANENTLY DELETE everything belonging to one league this season — players, coaches, games by default. Call count_league_contents first and pass its total as expect_count.", {
    league: ["string", true], expect_count: ["integer", true],
    types: { type: "array", items: { type: "string" } }, reason: "string",
  }),

  // ---- Seasons: registry, lifecycle, migration ----
  fn("list_seasons", "Every season with its own counts (players, teams, games…), which is active, which are locked, and each season's leagues. Use this for any 'how many in <other season>' question.", {}),
  fn("start_season", "Create a season, make it current, set its leagues, and optionally copy another season's divisions into it.", {
    name: ["string", true],
    leagues: { type: "array", items: { type: "string" } },
    copy_setup_from: "string",
  }),
  fn("set_active_season", "Switch which season is current.", { name: ["string", true] }),
  fn("set_season_lock", "Lock or unlock a season. A locked season is read-only — nothing in it can be changed.", {
    name: ["string", true], locked: ["boolean", true],
  }),
  fn("enroll_players_in_season", "Bring players into another season. Creates NEW records there and leaves the source season untouched. ALWAYS run with dry_run true first and report the count before doing it for real.", {
    to_season: ["string", true],
    from_season: "string",
    ids: { type: "array", items: { type: "integer" } },
    league: "string",
    bump_age: "boolean",
    keep_league: "boolean",
    dry_run: "boolean",
  }),
  fn("player_season_history", "Which seasons a player appears in, with their league/division/team in each.", { player_id: ["integer", true] }),
  fn("unassigned_report", "This season's unassigned players, split into no league / no division / no team.", { season: "string" }),
  fn("season_cleanup_report", "What needs fixing: records with no season, unused select choices, leagues a season doesn't claim, unassigned counts per season.", {}),
  fn("assign_orphans_to_season", "Give every season-less record to a named season.", {
    name: ["string", true], types: { type: "array", items: { type: "string" } },
  }),

  // ---- Exports ----
  fn("export_league", "Build an Excel or CSV export and return a download link (you can't attach a file yourself). scope 'attendance' with a week exports that one week's attendance sheet; without a week, the whole season's attendance grid.", {
    season: "string",
    league: "string",
    scope: { type: "string", enum: ["league", "season", "attendance"] },
    week: "string",
    format: { type: "string", enum: ["xlsx", "csv", "zip"] },
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
  // Only pass through the fields the caller actually named — movePlayer treats
  // "key present" as "change it", so spreading undefineds would blank a team.
  move_player: (a) => T.movePlayer(a.id, pick(a, ["league", "second_league", "division", "team"])),
  bulk_move_players: (a) => T.bulkMovePlayers(a.ids || [], pick(a, ["league", "second_league", "division", "team"]), a.mode || "set"),
  set_league_lock: (a) => T.setLeagueLock(a.league, !!a.locked),
  list_league_locks: () => ({ locks: T.getLeagueLocks() }),
  get_schedule: (a) => ({ games: T.getSchedule(a.league) }),
  find_games: (a) => T.findGames({ league: a.league, team: a.team, date: a.date, week: a.week, field: a.field, limit: a.limit }),
  edit_game: (a) => T.editGame(a.game_id, pick(a, ["date", "time", "field", "home_team", "away_team", "referee", "week"])),
  add_game: (a) => T.addGame({
    league: a.league, date: a.date, time: a.time, field: a.field,
    home_team: a.home_team, away_team: a.away_team, week: a.week, referee: a.referee,
  }),
  delete_game: (a) => {
    const row = getRow("records", Number(a.game_id));
    if (!row || row.type !== "game") return { error: `No game #${a.game_id}.` };
    return T.deleteRecord(Number(a.game_id));
  },
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
  set_checkin: (a) => T.setCheckin(a.player_id, a.player_name || "", a.week, a.status ?? !!a.present, { note: a.note, via: "s-dot" }),
  attendance_week: (a) => T.attendanceWeek({ week: a.week, league: a.league || null, division: a.division || null, team: a.team || null }),
  attendance_weeks: (a) => ({ weeks: T.attendanceWeeks(a.league || null) }),
  save_attendance_week: (a) => T.saveAttendanceWeek({ week: a.week, entries: a.entries || [], via: "s-dot" }),

  // ---- Late arrivals, divisions ----
  preview_place_on_teams: (a) => T.placeUnassignedPlayers({
    league: a.league || null, division: a.division || null, ids: a.ids || null,
    max_size: a.max_size ?? null, dry_run: true,
  }),
  place_on_teams: (a) => T.placeUnassignedPlayers({
    league: a.league || null, division: a.division || null, ids: a.ids || null,
    max_size: a.max_size ?? null, dry_run: false,
    reason: a.reason || "placed after team build",
  }),
  sort_into_divisions: () => T.reassignDivisions(),

  // ---- Bulk ----
  count_matching: (a) => T.countMatching({
    record_type: a.record_type || "player", league: a.league, division: a.division,
    team: a.team, field: a.field, op: a.op, value: a.value, ids: a.ids,
  }),
  bulk_delete_records: (a) => T.bulkDeleteRecords({
    record_type: a.record_type, ids: a.ids, league: a.league, division: a.division, team: a.team,
    field: a.field, op: a.op, value: a.value, expect_count: a.expect_count, reason: a.reason,
  }),
  count_league_contents: (a) => T.countLeagueContents(a.league, a.types || undefined),
  clear_league: (a) => T.clearLeague({ league: a.league, types: a.types || undefined, expect_count: a.expect_count, reason: a.reason }),

  // ---- Seasons ----
  list_seasons: () => SEASONS.listSeasons(),
  start_season: (a) => SEASONS.startSeason(a.name, a.leagues || [], {
    copy_setup_from: a.copy_setup_from || null, copy: { divisions: true },
  }),
  set_active_season: (a) => SEASONS.setActiveSeason(a.name),
  set_season_lock: (a) => (a.locked ? SEASONS.lockSeason(a.name) : SEASONS.unlockSeason(a.name)),
  enroll_players_in_season: (a) => SEASONS.enrollPlayersInSeason({
    ids: a.ids || null, from_season: a.from_season || null, to_season: a.to_season || null,
    league: a.league || null, bump_age: !!a.bump_age,
    keep_league: a.keep_league !== false, dry_run: !!a.dry_run,
  }),
  player_season_history: (a) => SEASONS.playerSeasonHistory(a.player_id),
  unassigned_report: (a) => SEASONS.unassignedFor(a.season || undefined),
  season_cleanup_report: () => SEASONS.seasonCleanupReport(),
  assign_orphans_to_season: (a) => SEASONS.assignOrphansToSeason(a.name, a.types || undefined),

  // ---- Exports ----
  // The agent can't hand over a file, so it builds the export to prove it works
  // and hands back the URL the UI turns into a download button.
  export_league: (a) => {
    const season = a.season || SC.currentScope().season;
    if (!season) return { error: "Which season should I export? (the picker is on \"All seasons\")" };
    const scope = a.scope || (a.week ? "attendance" : a.league ? "league" : "season");
    const format = a.format || "xlsx";
    const opts = { season, league: a.league || null, scope, week: a.week || null };
    const built = format === "zip" ? EXPORTS.exportCsvZip(opts)
                : format === "csv" ? EXPORTS.exportCsv(opts)
                :                    EXPORTS.exportXlsx(opts);
    if (built.error) return built;
    const q = new URLSearchParams({ season, format, scope });
    if (a.league) q.set("league", a.league);
    if (a.week) q.set("week", a.week);
    return {
      ok: true, season, league: a.league || null, scope, format, week: a.week || null,
      filename: built.filename,
      sheets: built.sheets,
      download_url: `/api/export?${q.toString()}`,
    };
  },
};

const READ = new Set([
  "query_data", "list_schema", "list_rules", "count_where", "breakdown", "find_records",
  "list_records",
  "get_field_options", "list_divisions", "list_league_locks", "get_schedule", "get_standings",
  "list_blackouts", "preview_rainout", "list_links", "list_flags",
  "list_assignment_rules", "list_team_rules", "get_press_queue",
  "list_seasons", "player_season_history", "unassigned_report", "season_cleanup_report", "find_games",
  "attendance_week", "attendance_weeks", "count_matching", "count_league_contents",
  "preview_place_on_teams",
  "export_league",
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
    case "bulk_delete_records":
    case "clear_league": {
      const n = Number(args.expect_count);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `"${name}" needs expect_count — the number you got from ${name === "clear_league" ? "count_league_contents" : "count_matching"} and told the user. Call that first; do not estimate it and do not read it off the screen.` };
      }
      if (name === "bulk_delete_records" && !args.record_type) {
        return { error: 'Missing "record_type" (e.g. "player").' };
      }
      if (name === "clear_league" && !args.league) return { error: 'Missing "league".' };
      return { ok: true, args: { ...args, expect_count: n } };
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
    case "move_player": return `Move player #${a.id}${a.team ? ` to **${a.team}**` : ""}${a.division ? ` (${a.division})` : ""}${a.league ? ` in ${a.league}` : ""}`;
    case "start_season": return `Start the **${a.name}** season${a.copy_setup_from ? ` (copying ${a.copy_setup_from}'s divisions)` : ""}`;
    case "set_active_season": return `Switch to the **${a.name}** season`;
    case "set_season_lock": return `${a.locked ? "Lock" : "Unlock"} the **${a.name}** season`;
    case "enroll_players_in_season": return `${a.dry_run ? "Preview enrolling" : "Enroll"} ${a.ids ? `${a.ids.length} player(s)` : `everyone${a.league ? ` in ${a.league}` : ""}${a.from_season ? ` from ${a.from_season}` : ""}`} into **${a.to_season}**`;
    case "assign_orphans_to_season": return `Give every untagged record to the **${a.name}** season`;
    case "export_league": return `Export ${a.league ? `**${a.league}**` : "the whole season"}${a.season ? ` (${a.season})` : ""} as ${(a.format || "xlsx").toUpperCase()}`;
    case "edit_game": return `Edit game #${a.game_id}${a.date ? ` → ${a.date}` : ""}${a.time ? ` ${a.time}` : ""}${a.field ? ` on ${a.field}` : ""}${a.referee ? ` · ref ${a.referee}` : ""}`;
    case "add_game": return `Add a game: **${a.home_team} v ${a.away_team}** on ${a.date}${a.time ? ` at ${a.time}` : ""}`;
    case "delete_game": return `Remove game #${a.game_id} from the schedule`;
    case "save_attendance_week": return `Mark ${(a.entries || []).length} player(s) for ${a.week}`;
    case "place_on_teams": return `Seat players with no team onto the existing teams${a.league ? ` in ${a.league}` : ""} — nobody already on a team is moved`;
    case "sort_into_divisions": return "Re-sort every player into the age bracket their age falls into";
    case "bulk_delete_records": return `⚠️ Permanently delete **${a.expect_count} ${a.record_type}${Number(a.expect_count) === 1 ? "" : "s"}**${a.league ? ` in ${a.league}` : ""}${a.team ? ` on ${a.team}` : ""}`;
    case "clear_league": return `⚠️ Clear **${a.league}** — permanently delete all ${a.expect_count} record(s) in it this season`;
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
// Copy only the keys the model actually supplied. Tools that use
// hasOwnProperty to decide "did they mean to change this?" depend on it.
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj || {}, k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

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
