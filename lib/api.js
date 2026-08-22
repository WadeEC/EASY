// Parse a response without ever throwing on an empty or non-JSON body (e.g. a 500
// or a hot-reload hiccup returns no JSON). Callers get a plain object they can read.
async function safeJson(r, url) {
  let text = "";
  try { text = await r.text(); } catch { text = ""; }
  if (!text) {
    if (!r.ok && typeof console !== "undefined") console.warn(`API ${url} -> ${r.status} (empty response)`);
    return r.ok ? {} : { error: `Request failed (${r.status || "network"})` };
  }
  try { return JSON.parse(text); }
  catch {
    if (typeof console !== "undefined") console.warn(`API ${url} -> non-JSON response (${r.status})`);
    return { error: `Unexpected response from ${url}` };
  }
}

// Auto-toast plumbing — every write the user makes (save / add / assign / etc.)
// should confirm visually so the user knows the click went through. The api
// layer is the one place every write funnels through, so we fire toasts here
// instead of touching every component. Read-only actions and bookkeeping calls
// (loading lists, polling status) stay silent.
const READ_ACTIONS = new Set([
  "list", "config", "status", "preview", "report", "context", "summary",
  "board", "detail", "filter", "search", "low_avail", "pay_report",
  "rainout_preview", "blackouts_list", "locks_list", "standings",
]);
// Action `save`/`clear` are reused across schedule, teams, etc. — keep labels
// generic ("Saved" / "Cleared") so they're never wrong, and let each page's
// inline flash banner carry the specific count / context.
const ACTION_LABELS = {
  // schedule + teams + generic
  save: "Saved",
  clear: "Cleared",
  assign_ref: "Referee assigned",
  mark_worked: "Game marked done",
  unmark_worked: "Mark removed",
  ref_shift: "Referee shift logged",
  set_score: "Score saved",
  clear_score: "Score cleared",
  blackout_add: "Blackout added",
  blackout_remove: "Blackout removed",
  rainout_apply: "Rainout applied",
  reschedule_date: "Games rescheduled",
  prune_cross_division: "Cross-division games removed",
  // teams / rules / links — the team `save` action falls through to the generic
  // "Saved" label above; no separate preview_save action exists in the route.
  add_rule: "Rule added",
  del_rule: "Rule removed",
  toggle_rule: "Rule updated",
  link: "Players linked",
  set_link_reason: "Link reason saved",
  unlink: "Player unlinked",
  // attendance / kiosk / board
  toggle: "Updated",
  confirm_size: "Roster size confirmed",
  scan: "Scan saved",
  scan_id: "Scan saved",
  note: "Note saved",
  set_jersey: "Jersey updated",
  // flags / settings / memory
  add: "Added",
  del: "Removed",
  create: "Created",
  delete: "Removed",
  update: "Saved",
  setup: "Setup complete",
  reassign: "Reassigned",
  setup_coaches: "Coaches set up",
  set_all_star_cap: "All-star cap saved",
  // `ensure` / `ensure_player_fields` / `ensure_referees` / `ensure_tournaments`
  // intentionally absent — these are idempotent setup safeguards called on mount.
  balance: "Balance updated",
  finalize: "Ranking finalized",
  move: "Moved",
  move_bulk: "Players moved",
  locks_set: "Lock updated",
  set_override: "Override saved",
  set_active: "Season set as current",
  backfill: "Season tags applied",
  start: "Season started",
  set_leagues: "Season leagues saved",
  approve: "Approved",
  reject: "Rejected",
  jersey_hold: "Jersey hold applied",
  add_member: "Added to link",
  remove_member: "Removed from link",
  set_reason: "Link reason saved",
  seed_standard: "Standard divisions added",
};
function _toast(detail) {
  if (typeof window === "undefined") return;
  if ((window.__ffToastSilenceUntil || 0) > Date.now()) return;
  window.dispatchEvent(new CustomEvent("ff:toast", { detail }));
}
// Endpoints that are bare REST writes (no `action` field on the body). The
// HTTP method + URL determines the success label. Anything not matched here
// stays silent so kiosk lookups and other read-style POSTs don't spam.
const NO_ACTION_WRITE_LABELS = [
  { test: (u, m) => m === "POST" && /\/api\/records\b/.test(u), label: "Record added" },
  { test: (u, m) => (m === "PATCH" || m === "PUT") && /\/api\/records\b/.test(u), label: "Saved" },
  { test: (u, m) => m === "DELETE" && /\/api\/records\b/.test(u), label: "Removed" },
  { test: (u, m) => m === "POST" && /\/api\/assignment\b/.test(u), label: "Assignment saved" },
  { test: (u, m) => m === "PUT" && /\/api\/assignment\b/.test(u), label: "Reassigned" },
  { test: (u, m) => m === "DELETE" && /\/api\/assignment\b/.test(u), label: "Assignment removed" },
  { test: (u, m) => m === "POST" && /\/api\/option\b/.test(u), label: "Option saved" },
  { test: (u, m) => m === "POST" && /\/api\/seed\b/.test(u), label: "Sample data loaded" },
  { test: (u, m) => m === "POST" && /\/api\/import\/markers\b/.test(u), label: "Markers saved" },
  { test: (u, m) => m === "POST" && /\/api\/import(\b|$|\?)/.test(u) && !/\/(detect|ask-ai|markers)/.test(u), label: "Import applied" },
  // /api/apply is the AI assistant's "Apply changes" button — always a user-
  // initiated write. /api/schema POST without an `action` is addField (the
  // ensure_* actions are silent because they're filtered earlier).
  { test: (u, m) => m === "POST" && /\/api\/apply\b/.test(u), label: "Changes applied" },
  { test: (u, m) => m === "POST" && /\/api\/schema\b/.test(u), label: "Field added" },
];
// Endpoints that fire constantly in the background — agent / poll / lookup.
// They stay silent on success; real errors still toast so a hot-reload hiccup
// or auth blip doesn't go unnoticed. /api/attendance, /api/board, /api/roster,
// /api/master, /api/press are intentionally NOT here — they're a mix of reads
// (silent via READ_ACTIONS) and writes the user should see confirmed.
const BACKGROUND_PATTERNS = /\/api\/(agent|state|health|memory|history|code-approvals|ai-filter|kiosk|auth)\b/;

function _maybeToastResult(url, body, method, result) {
  if (typeof window === "undefined") return;
  if ((window.__ffToastSilenceUntil || 0) > Date.now()) return;
  if (BACKGROUND_PATTERNS.test(url)) {
    if (result && result.error) _toast({ text: String(result.error), kind: "error", ms: 5000 });
    return;
  }
  const action = body && typeof body === "object" ? body.action : null;
  if (action) {
    if (READ_ACTIONS.has(action)) return;
    if (!ACTION_LABELS[action]) return;   // unknown action — stay silent rather than mislabel
    _toast(result?.error
      ? { text: result.error, kind: "error", ms: 5000 }
      : { text: ACTION_LABELS[action], kind: "success" });
    return;
  }
  for (const rule of NO_ACTION_WRITE_LABELS) {
    if (rule.test(url, method || "POST")) {
      _toast(result?.error
        ? { text: result.error, kind: "error", ms: 5000 }
        : { text: rule.label, kind: "success" });
      return;
    }
  }
}
// The admin account currently acting — stamped on every change for the audit log.
function actorHeader() {
  try { const a = (typeof localStorage !== "undefined" && localStorage.getItem("ff_admin")) || ""; return a ? { "x-ff-actor": a } : {}; }
  catch { return {}; }
}
// The sidebar's season picker, sent on EVERY request so the server scopes
// players / teams / schedule / standings / master to the chosen season.
//
// The header is always sent, never omitted. An absent header used to mean
// "all seasons", which is the same thing a page that simply forgot to send it
// looks like — and that ambiguity is how cross-season numbers got through.
// Now the vocabulary is explicit:
//   "Fall 2026"   → that season
//   "*"           → every season, deliberately
//   "(no season)" → the legacy untagged bucket
// and a missing header means "use the active season", which is always safe.
export const ALL_SEASONS = "*";
export function currentSeason() {
  try {
    const s = typeof localStorage !== "undefined" ? localStorage.getItem("ff_season") : null;
    return s == null || s === "" ? ALL_SEASONS : s;
  } catch { return ALL_SEASONS; }
}
function seasonHeader() {
  return { "x-ff-season": currentSeason() };
}
async function jget(url) {
  try { const r = await fetch(url, { headers: { ...actorHeader(), ...seasonHeader() } }); return await safeJson(r, url); }
  catch (e) { return { error: String(e && e.message || e) }; }
}
async function jbody(url, body, method = "POST") {
  let result;
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...actorHeader(), ...seasonHeader() },
      body: JSON.stringify(body || {}),
    });
    result = await safeJson(r, url);
  } catch (e) { result = { error: String(e && e.message || e) }; }
  try { _maybeToastResult(url, body, method, result); } catch {}
  return result;
}

export const api = {
  state: () => jget("/api/state"),
  schema: (type) => jget("/api/schema" + (type ? `?type=${encodeURIComponent(type)}` : "")),
  records: (type) => jget(`/api/records?type=${encodeURIComponent(type)}`),
  createRecord: (type, fields, name) => jbody("/api/records", { type, fields, name }),
  updateRecord: (id, fields) => jbody("/api/records", { id, fields }, "PATCH"),
  deleteRecord: (id) => jbody("/api/records", { id }, "DELETE"),
  addField: (b) => jbody("/api/schema", b),
  ensurePlayerFields: () => jbody("/api/schema", { action: "ensure_player_fields" }),
  agent: (messages, pageContext) => jbody("/api/agent", { messages, pageContext }),
  apply: (plan) => jbody("/api/apply", { plan }),
  undo: (token) => jbody("/api/undo", { token }),
  codePendingList: () => jget("/api/code-approvals"),
  codeApprove: (id) => jbody("/api/code-approvals", { action: "approve", id }),
  codeReject: (id) => jbody("/api/code-approvals", { action: "reject", id }),
  memoryList: () => jget("/api/memory"),
  memoryRemember: (key, value, scope) => jbody("/api/memory", { key, value, scope }),
  memoryForget: (id) => jbody("/api/memory", { forget: id }),
  health: () => jget("/api/health"),
  forceProvider: (force) => jbody("/api/health", { force }),
  probeProviders: () => jbody("/api/health", { probe: true }),
  option: (record_type, field, option) => jbody("/api/option", { record_type, field, option }),
  assignment: (type) => jget(`/api/assignment?type=${encodeURIComponent(type || "player")}`),
  createAssignment: (b) => jbody("/api/assignment", b),
  deleteAssignment: (id) => jbody("/api/assignment", { id }, "DELETE"),
  reassignAll: (record_type = "player") => jbody("/api/assignment", { record_type }, "PUT"),
  aiFilter: (b) => jbody("/api/records/ai-filter", b),
  rules: () => jget("/api/rules"),
  ruleAction: (b) => jbody("/api/rules", b),
  seed: () => jbody("/api/seed", {}),
  importRows: (b) => jbody("/api/import", b),
  importDetect: (b) => jbody("/api/import/detect", b),
  importMarkers: (b) => jbody("/api/import/markers", b),
  importAskAi: (b) => jbody("/api/import/ask-ai", b),
  // Seasons — list/add/set-active/backfill. A season is a tag on every player;
  // imports stamp it and views filter by it.
  seasonsList: () => jget("/api/seasons"),
  seasonAdd: (name) => jbody("/api/seasons", { action: "add", name }),
  seasonSetActive: (name) => jbody("/api/seasons", { action: "set_active", name }),
  seasonBackfill: (name) => jbody("/api/seasons", { action: "backfill", name }),
  seasonStart: (name, leagues, copy_setup_from) =>
    jbody("/api/seasons", { action: "start", name, leagues, copy_setup_from: copy_setup_from || null }),
  seasonSetLeagues: (name, leagues) => jbody("/api/seasons", { action: "set_leagues", name, leagues }),
  seasonLock: (name) => jbody("/api/seasons", { action: "lock", name }),
  seasonUnlock: (name) => jbody("/api/seasons", { action: "unlock", name }),
  seasonArchive: (name) => jbody("/api/seasons", { action: "archive", name }),
  seasonReopen: (name) => jbody("/api/seasons", { action: "reopen", name }),
  seasonCopySetup: (from, to, copy) => jbody("/api/seasons", { action: "copy_setup", from, to, copy }),
  seasonAssignOrphans: (name, types) => jbody("/api/seasons", { action: "assign_orphans", name, types }),
  seasonCleanup: () => jget("/api/seasons?report=cleanup"),
  seasonHistoryFor: (playerId) => jget(`/api/seasons?history=${encodeURIComponent(playerId)}`),
  // Enrollment = bringing players into another season. The source season is
  // never touched; dry_run first so the count can be confirmed.
  seasonEnroll: (b) => jbody("/api/seasons", { action: "enroll", ...b }),
  history: () => jget("/api/history"),
  undoOne: (id) => jbody("/api/history", { id }),
  restorePoint: (afterId) => jbody("/api/history", { restoreTo: afterId }),
  teamConfig: () => jbody("/api/teams", { action: "config" }),
  coachSetup: () => jbody("/api/teams", { action: "setup_coaches" }),
  setAllStarCap: (max) => jbody("/api/teams", { action: "set_all_star_cap", max }),
  scheduleConfig: () => jbody("/api/schedule", { action: "config" }),
  schedulePreview: (b) => jbody("/api/schedule", { action: "preview", ...b }),
  scheduleSave: (b) => jbody("/api/schedule", { action: "save", ...b }),
  scheduleClear: (league) => jbody("/api/schedule", { action: "clear", league: league || null }),
  scheduleRainoutPreview: (date, league) => jbody("/api/schedule", { action: "rainout_preview", date, league: league || null }),
  scheduleRainoutApply: (date, league, reason) => jbody("/api/schedule", { action: "rainout_apply", date, league: league || null, reason: reason || "Rainout" }),
  scheduleRescheduleDate: (from, to, league, dry) => jbody("/api/schedule", { action: "reschedule_date", from, to, league: league || null, dry: !!dry }),
  schedulePruneCrossDivision: (league) => jbody("/api/schedule", { action: "prune_cross_division", league: league || null }),
  scheduleList: (league) => jbody("/api/schedule", { action: "list", league }),
  scheduleAssignRef: (game_id, referee) => jbody("/api/schedule", { action: "assign_ref", game_id, referee }),
  gameMarkWorked: (game_id, ref_name) => jbody("/api/schedule", { action: "mark_worked", game_id, ref_name }),
  gameUnmarkWorked: (game_id, ref_name) => jbody("/api/schedule", { action: "unmark_worked", game_id, ref_name }),
  refShift: (ref_name, shift) => jbody("/api/schedule", { action: "ref_shift", ref_name, shift }),
  payReport: (opts = {}) => jbody("/api/schedule", { action: "pay_report", ...opts }),
  gameSetScore: (game_id, b) => jbody("/api/schedule", { action: "set_score", game_id, ...b }),
  gameClearScore: (game_id) => jbody("/api/schedule", { action: "clear_score", game_id }),
  standings: (league) => jbody("/api/schedule", { action: "standings", league: league || null }),
  activeWeekGet: () => jget("/api/settings/checkin-week"),
  activeWeekSet: (week) => jbody("/api/settings/checkin-week", { week: week || "" }),
  weekRename: (week, label) => jbody("/api/settings/checkin-week", { action: "label", week, label }),
  weekCancel: (week, cancelled) => jbody("/api/settings/checkin-week", { action: "cancel", week, cancelled }),
  pressList: (league) => jbody("/api/press", { action: "list", league: league || null }),
  pressStatus: (player_id) => jbody("/api/press", { action: "status", player_id }),
  pressSetOverride: (player_id, override, reason) => jbody("/api/press", { action: "set_override", player_id, override, reason }),
  blackoutsList: (league) => jbody("/api/schedule", { action: "blackouts_list", league: league || null }),
  blackoutAdd: (b) => jbody("/api/schedule", { action: "blackout_add", ...b }),
  blackoutRemove: (id) => jbody("/api/schedule", { action: "blackout_remove", id }),
  rainoutPreview: (b) => jbody("/api/schedule", { action: "rainout_preview", ...b }),
  rainoutApply: (b) => jbody("/api/schedule", { action: "rainout_apply", ...b }),
  teamsLowAvail: () => jbody("/api/teams", { action: "low_avail" }),
  teamsPreview: (opts) => jbody("/api/teams", { action: "preview", ...opts }),
  teamsSave: (teams) => jbody("/api/teams", { action: "save", teams }),
  teamAddRule: (type, field) => jbody("/api/teams", { action: "add_rule", type, field }),
  teamDelRule: (id) => jbody("/api/teams", { action: "del_rule", id }),
  teamToggleRule: (id, active) => jbody("/api/teams", { action: "toggle_rule", id, active }),
  linkPlayers: (ids, group, reason) => jbody("/api/teams", { action: "link", ids, group, reason }),
  setLinkReason: (group, reason) => jbody("/api/teams", { action: "set_link_reason", group, reason }),
  unlinkPlayer: (id) => jbody("/api/teams", { action: "unlink", id }),
  flags: () => jbody("/api/flags", { action: "list" }),
  flagAdd: (b) => jbody("/api/flags", { action: "add", ...b }),
  flagDel: (id) => jbody("/api/flags", { action: "del", id }),
  flagToggle: (id, active) => jbody("/api/flags", { action: "toggle", id, active }),
  flagJerseyHold: () => jbody("/api/flags", { action: "jersey_hold" }),
  ensureReferees: () => jbody("/api/schema", { action: "ensure_referees" }),
  ensureTournaments: () => jbody("/api/schema", { action: "ensure_tournaments" }),
  rankingEnsure: () => jbody("/api/ranking", { action: "ensure" }),
  rankingStatus: () => jbody("/api/ranking", { action: "status" }),
  rankingBalance: (on) => jbody("/api/ranking", { action: "balance", on }),
  rankingFinalize: (label) => jbody("/api/ranking", { action: "finalize", label }),
  divisionsStatus: () => jbody("/api/divisions", { action: "status" }),
  divisionsSetup: () => jbody("/api/divisions", { action: "setup" }),
  divisionsReassign: () => jbody("/api/divisions", { action: "reassign" }),
  attendanceList: (b) => jbody("/api/attendance", { action: "list", ...b }),
  attendanceToggle: (b) => jbody("/api/attendance", { action: "toggle", ...b }),
  attendanceConfirmSize: (b) => jbody("/api/attendance", { action: "confirm_size", ...b }),
  attendanceScan: (b) => jbody("/api/attendance", { action: "scan", ...b }),
  attendanceReport: (b) => jbody("/api/attendance", { action: "report", ...b }),
  // One week as an editable sheet: everyone on the roster with present /
  // absent / excused / not-taken, who marked it and when.
  attendanceWeekSheet: (b) => jbody("/api/attendance", { action: "week_sheet", ...b }),
  attendanceSaveWeek: (week, entries) => jbody("/api/attendance", { action: "save_week", week, entries }),
  attendanceWeeks: (league) => jbody("/api/attendance", { action: "weeks", league: league || null }),
  kioskSearch: (b) => jbody("/api/kiosk", b),
  boardData: (week) => jbody("/api/board", { action: "board", week }),
  boardScan: (b) => jbody("/api/board", { action: "scan", ...b }),
  boardScanId: (b) => jbody("/api/board", { action: "scan_id", ...b }),
  boardNote: (b) => jbody("/api/board", { action: "note", ...b }),
  boardDetail: (b) => jbody("/api/board", { action: "detail", ...b }),
  boardToggle: (b) => jbody("/api/board", { action: "toggle", ...b }),
  boardSetJersey: (player_id, issued) => jbody("/api/board", { action: "set_jersey", player_id, issued }),
  boardSetJerseySize: (player_id, size) => jbody("/api/board", { action: "set_jersey_size", player_id, size }),
  divisionsList: () => jbody("/api/divisions", { action: "list" }),
  divisionCreate: (b) => jbody("/api/divisions", { action: "create", ...b }),
  divisionDel: (id) => jbody("/api/divisions", { action: "del", id }),
  divisionsSeed: () => jbody("/api/divisions", { action: "seed_standard" }),
  rosterContext: () => jbody("/api/roster", { action: "context" }),
  rosterMove: (id, changes) => jbody("/api/roster", { action: "move", id, changes }),
  rosterMoveBulk: (ids, changes, mode) => jbody("/api/roster", { action: "move_bulk", ids, changes, mode }),
  leagueLocks: () => jbody("/api/roster", { action: "locks_list" }),
  setLeagueLock: (league, locked) => jbody("/api/roster", { action: "locks_set", league, locked }),
  // Generalized player-link model (sibling / coach_player / carpool / do_not_link).
  // Lives alongside the legacy link_group system — both are honored by the builder.
  linksList: () => jbody("/api/links", { action: "list" }),
  linkCreate: (b) => jbody("/api/links", { action: "create", ...b }),
  linkDelete: (link_id) => jbody("/api/links", { action: "delete", link_id }),
  linkAddMember: (link_id, member) => jbody("/api/links", { action: "add_member", link_id, ...member }),
  linkRemoveMember: (link_id, member) => jbody("/api/links", { action: "remove_member", link_id, ...member }),
  linkSetReason: (link_id, reason) => jbody("/api/links", { action: "set_reason", link_id, reason }),
  // Import master spreadsheet — every imported row, including unmapped columns.
  masterSummary: (type) => jbody("/api/master", { action: "summary", type: type || null }),
  masterList: (type) => jbody("/api/master", { type: type || null, format: "json" }),
  // Downloads go straight to the URL, which always carries the season:
  masterDownloadUrl: (type, format = "xlsx", season) =>
    `/api/master?format=${format}` +
    (type ? `&type=${encodeURIComponent(type)}` : "") +
    `&season=${encodeURIComponent(season || currentSeason())}`,

  // ---- This season's Unassigned ----
  unassigned: (season) => jget("/api/unassigned" + (season ? `?season=${encodeURIComponent(season)}` : "")),
  unassignedPlace: (opts = {}) => jbody("/api/unassigned", { action: "place_on_teams", ...opts }),
  unassignedAssign: (ids, changes) => jbody("/api/unassigned", { action: "assign", ids, ...changes }),
  unassignedAutoDivision: () => jbody("/api/unassigned", { action: "auto_division" }),

  // ---- Excel / CSV exports ----
  exportOptions: () => jget("/api/export?format=options"),
  exportUrl: ({ season, league = null, scope = null, format = "xlsx", sheet = null, week = null } = {}) => {
    const q = new URLSearchParams();
    q.set("season", season || currentSeason());
    if (league) q.set("league", league);
    q.set("scope", scope || (week ? "attendance" : league ? "league" : "season"));
    q.set("format", format);
    if (week) q.set("week", week);
    if (sheet) q.set("sheet", sheet);
    return `/api/export?${q.toString()}`;
  },
};
