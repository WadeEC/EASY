// Short, specific things S-Dot can help with on each page — used by the
// floating widget AND any inline "Or ask S-Dot" cards. Clicking a chip sends
// that exact text as the user message, so the model gets a tight intent
// instead of an open "what do you want?" — cheap on tokens both ways.
export const PAGE_PROMPTS = {
  home: [
    "Show me what needs attention",
    "Add a player — walk me through it",
    "Build teams — walk me through it",
  ],
  people: [
    "Players with no jersey size",
    "Filter to a league",
    "Add a player — walk me through it",
  ],
  section: [
    "Filter this list",
    "Show records missing a detail",
    "Add a detail — walk me through it",
  ],
  teambuilder: [
    "Build teams — walk me through it",
    "Keep siblings together",
    "Spread all-stars",
  ],
  schedule: [
    "Build a schedule — walk me through it",
    "Reschedule a specific date",
    "Block off a week",
  ],
  attendance: [
    "Who missed the last 2 weeks?",
    "Mark week present from a list",
    "Show low-attendance players",
  ],
  rankings: [
    "Rank a team — walk me through it",
    "Players ranked 1–2",
    "Lock the season ranks",
  ],
  raffle: [
    "Draw a winner",
    "Eligible players",
    "Reset the raffle",
  ],
  leagues: [
    "Add a rule — walk me through it",
    "Add a township",
    "List active rules",
  ],
  tournaments: [
    "Create a tournament — walk me through it",
    "List saved tournaments",
    "Add fields to a tournament",
  ],
  changelog: [
    "What changed today?",
    "Undo the last change",
    "Show deletions this week",
  ],
  timemachine: [
    "Restore yesterday's state",
    "What did the schedule look like Monday?",
  ],
  advanced: [
    "Export the schema",
    "Rename a section",
    "Show low-use fields",
  ],
  assigned: [
    "Games I'm assigned to",
    "Open my game packet",
  ],
  coverage: [
    "Find an unassigned game",
    "Who's available Saturday?",
  ],
  master: [
    "Export the master spreadsheet",
    "Filter to one district",
    "Show only added rows",
  ],
  standings: [
    "Enter scores for last weekend",
    "Show standings for one league",
    "Mark a forfeit",
  ],
  board: [
    "Show today's check-ins",
    "Mark a player present by name",
  ],
  scanin: [
    "Find a player",
    "Mark size confirmed",
  ],
};

export const DEFAULT_PROMPTS = ["Show me data I should look at", "Make a quick edit", "Build a small report"];

// Read the active page from the URL ?v=... query the app already uses for nav.
export function currentPageId() {
  if (typeof window === "undefined") return "home";
  const v = new URLSearchParams(window.location.search).get("v") || "home";
  return v.split(".")[0] || "home";
}

export const PAGE_LABEL = {
  home: "Home",
  people: "Players & Coaches",
  section: "this section",
  teambuilder: "Team Builder",
  schedule: "the Schedule page",
  attendance: "Attendance",
  rankings: "Player Rankings",
  raffle: "Raffle",
  leagues: "Leagues & Assignment",
  tournaments: "Tournaments",
  changelog: "the Change log",
  timemachine: "Time Machine",
  advanced: "Advanced",
  assigned: "Referee assignments",
  coverage: "Referee coverage",
  master: "the Master spreadsheet",
  standings: "Standings & Scores",
  board: "Team Board",
  scanin: "the Kiosk",
};

// Get the prompt list for a page id, falling back to defaults.
export function promptsFor(pageId) {
  return PAGE_PROMPTS[pageId] || DEFAULT_PROMPTS;
}
