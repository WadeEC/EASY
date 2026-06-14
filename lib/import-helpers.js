// Shared helpers for roster-import surfaces (the Section ImportTab and the Home-page
// ImportPlayers). Keep this file client-safe — no Node-only imports — so both server
// routes and React components can pull from it.
//
// Exports:
//   HEADER_ALIASES   — field name → list of alternate column headers we expect on real sheets
//   normHeader(s)    — normalize a header string for alias comparison
//   guessHeader(f,c) — pick the best column header for a given field
//   prepareImport()  — parse rows + synthesize Full Name + build mapping in one go
//   mappedCount(m)   — count non-skip entries in a mapping

// Common header aliases mapped to known field names. Used to auto-pick the right column
// from an uploaded roster spreadsheet.
export const HEADER_ALIASES = {
  full_name: ["name", "player name", "child name", "first last", "kid name", "athlete", "registrant", "athlete name", "player full name", "child", "kid", "participant", "participant name", "name of player", "registration name"],
  first_name: ["first", "fname", "given", "first name", "player first name", "child first name", "given name", "athlete first name"],
  last_name: ["last", "lname", "surname", "family", "last name", "player last name", "child last name", "family name", "athlete last name"],
  age: ["age", "years", "yrs", "age as of", "current age"],
  dob: ["dob", "date of birth", "birth date", "birthdate", "birthday", "born", "birth"],
  parent_phone: ["phone", "tel", "telephone", "mobile", "cell", "parent phone", "guardian phone", "contact", "primary phone", "cell phone", "mom phone", "dad phone", "parent cell", "guardian cell", "phone number", "phone #", "cell #", "mobile #"],
  email: ["email", "e-mail", "parent email", "guardian email", "email address", "parent email address"],
  township: ["township", "town", "city", "municipality", "district", "borough", "home town"],
  league: ["league", "program", "session", "league name"],
  jersey_size: ["jersey", "jersey size", "size", "shirt size", "t-shirt", "tee", "tshirt", "shirt", "uniform size", "t shirt size", "youth size"],
  key_tag: ["key tag", "keytag", "tag", "scan", "scan number", "badge", "card", "rfid", "id", "id number", "player id", "scan id"],
  team: ["team", "roster", "team name", "team assignment"],
  division: ["division", "age group", "bracket", "group", "age division"],
  school: ["school", "elementary", "school name", "school attended"],
  address: ["address", "street", "home address", "street address", "mailing address"],
  zip: ["zip", "postal", "zipcode", "zip code", "postal code"],
  notes: ["notes", "note", "comments", "remarks", "comment"],
  parent_name: ["parent", "parent name", "guardian", "guardian name", "mom name", "dad name", "primary contact"],
  // Coach
  role: ["role", "position", "title", "coach role"],
  child_name: ["child", "child name", "kid", "player", "child's name", "kid name", "player name"],
  coach_type: ["coach type", "type", "parent type", "volunteer type"],
  // Referee
  field: ["field", "home field", "primary field", "venue"],
  rate_per_game: ["rate", "pay", "pay rate", "per game", "rate per game", "$/game", "rate/game"],
};

// Fields that should NOT be auto-mapped from a CSV column. league + township come
// from the website's prediction (Assignment rules / township picker). key_tag is
// assigned in-app at scan-in, not read from registration sheets — auto-mapping
// columns like "Family ID" to it would create false scan associations.
// The import form leaves these on "(skip)" by default; the user can still pick a
// column manually if they really want to.
export const PREDICTED_FIELDS = new Set(["league", "township", "key_tag"]);

// Normalize a header into a plain comparable form:
//   "Parent Cell #"     → "parent cell"
//   "T-Shirt_Size"      → "t shirt size"
//   "player_first_name" → "player first name"
// Strips punctuation, lowercases, collapses runs of whitespace.
export const normHeader = (s) => String(s || "")
  .toLowerCase()
  .replace(/['"`]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

export function guessHeader(field, cols) {
  const aliasList = (HEADER_ALIASES[field.name] || []).concat(field.label ? [field.label] : []).concat(field.name);
  const normAliases = aliasList.map(normHeader).filter(Boolean);
  if (!normAliases.length) return "(skip)";
  // 1) Exact-normalized match wins.
  for (const c of cols) { if (normAliases.includes(normHeader(c))) return c; }
  // 2) Tokenized match: every token of an alias appears in the header (order-insensitive).
  for (const c of cols) {
    const tokens = normHeader(c).split(" ").filter(Boolean);
    if (!tokens.length) continue;
    for (const a of normAliases) {
      const aTokens = a.split(" ").filter(Boolean);
      if (aTokens.length && aTokens.every((t) => tokens.includes(t))) return c;
    }
  }
  // 3) Substring (incoming header contains an alias as a contiguous string).
  for (const c of cols) {
    const n = normHeader(c);
    if (normAliases.some((a) => a && n.includes(a))) return c;
  }
  // 4) Reverse substring (an alias contains the incoming header — short headers like "tel").
  for (const c of cols) {
    const n = normHeader(c);
    if (!n) continue;
    if (normAliases.some((a) => a && a.includes(n))) return c;
  }
  return "(skip)";
}

// Detect the real header row in an array-of-arrays (AOA) parse of a worksheet.
// Real-world rosters often have a title banner (5–10 rows of "Activity:", "Season:", etc.)
// before the actual headers. The header row is the first row with significantly more
// populated cells than any prior row, AND at least 3 populated cells, AND mostly strings.
// Returns the 0-based index of the header row (defaults to 0 if nothing qualifies).
export function detectHeaderRow(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return 0;
  const counts = aoa.map((r) => (r || []).filter((c) => c != null && c !== "").length);
  const stringy = aoa.map((r) => (r || []).filter((c) => typeof c === "string" && c.trim().length).length);
  let prevMax = 0;
  for (let i = 0; i < counts.length; i++) {
    // Heuristic: a header row is one where populated cells jump to ≥ 3
    // AND at least double the previous max AND most populated cells are strings.
    if (counts[i] >= 3 && counts[i] >= prevMax * 2 && stringy[i] >= Math.max(3, Math.floor(counts[i] * 0.6))) {
      return i;
    }
    if (counts[i] > prevMax) prevMax = counts[i];
  }
  // Fallback: first row with ≥ 3 populated cells.
  for (let i = 0; i < counts.length; i++) if (counts[i] >= 3) return i;
  return 0;
}

// Parse an array-of-arrays into row-objects keyed by the detected header row.
// Skips banner rows above the header and blank rows below.
// Returns { rows, cols, headerIdx, skippedBannerRows }.
export function parseSheetAoa(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return { rows: [], cols: [], headerIdx: 0, skippedBannerRows: 0 };
  const headerIdx = detectHeaderRow(aoa);
  const rawHeaders = (aoa[headerIdx] || []).map((h, i) => {
    const s = h == null ? "" : String(h).trim();
    return s || `Column ${i + 1}`;
  });
  // Dedupe header names (some sheets have repeated column titles).
  const seen = new Set();
  const cols = rawHeaders.map((h) => {
    let n = h; let i = 2;
    while (seen.has(n)) n = `${h} (${i++})`;
    seen.add(n); return n;
  });
  const rows = [];
  for (let r = headerIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    if (row.every((c) => c == null || c === "")) continue; // skip blank rows
    const obj = {};
    for (let c = 0; c < cols.length; c++) obj[cols[c]] = row[c] == null ? null : row[c];
    rows.push(obj);
  }
  return { rows, cols, headerIdx, skippedBannerRows: headerIdx };
}

// Prepare an uploaded sheet: parse rows, synthesize Full Name if only First/Last exist,
// and build a default field→column mapping using the alias-based guesser.
// Accepts either { parsedRows } (legacy — uses row[0]'s keys as headers) or
// { aoa } (preferred — runs banner-aware header detection).
// Returns { rows, cols, mapping, synthesizedFullName, headerIdx, skippedBannerRows }.
export function prepareImport({ parsedRows, aoa, fields }) {
  let r, cols, headerIdx = 0, skippedBannerRows = 0;
  if (Array.isArray(aoa) && aoa.length) {
    const parsed = parseSheetAoa(aoa);
    r = parsed.rows; cols = parsed.cols;
    headerIdx = parsed.headerIdx; skippedBannerRows = parsed.skippedBannerRows;
  } else {
    r = parsedRows || [];
    cols = r.length ? Object.keys(r[0]) : [];
  }
  let synthesizedFullName = false;
  const firstCol = guessHeader({ name: "first_name", label: "First Name" }, cols);
  const lastCol = guessHeader({ name: "last_name", label: "Last Name" }, cols);
  // Look for a STRONG full-name column — exact normalized match against the strong aliases only,
  // not the weak "name" token. "Last Name" / "First Name" should NOT count as a full-name column.
  const strongFullAliases = ["full name", "player name", "athlete name", "child name", "kid name", "registrant", "participant name", "name of player", "registration name", "player full name"];
  const realFullCol = cols.find((c) => strongFullAliases.includes(normHeader(c)));
  if (!realFullCol && firstCol !== "(skip)" && lastCol !== "(skip)") {
    r = r.map((row) => ({ ...row, "Full Name": [row[firstCol], row[lastCol]].filter(Boolean).join(" ").trim() || null }));
    cols = [...cols, "Full Name"];
    synthesizedFullName = true;
  }
  const mapping = {};
  // league + township are never auto-mapped from a spreadsheet column — they come
  // from the website's prediction (Assignment rules / township picker) instead.
  // Defaulting them to "(skip)" lets evaluateAssignment fill them in at create time.
  for (const f of (fields || [])) {
    mapping[f.name] = PREDICTED_FIELDS.has(f.name) ? "(skip)" : guessHeader(f, cols);
  }
  // If we synthesized Full Name, force the mapping to use it — overrides any stray
  // guesser hit on "Last Name" or similar via the weak "name" token.
  if (synthesizedFullName) mapping.full_name = "Full Name";
  return { rows: r, cols, mapping, synthesizedFullName, headerIdx, skippedBannerRows };
}

// Count how many fields were actually mapped (non-skip).
export function mappedCount(mapping) {
  return Object.values(mapping || {}).filter((v) => v && v !== "(skip)").length;
}
