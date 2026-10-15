// Which game does a team play "this week" — and what jersey does it wear?
//
// Both check-in screens (the self-service kiosk and the staff Team Board panel)
// need the same answer, so it lives here once instead of twice.
//
// Jersey color convention (FR-3.7): home team wears LIGHT, away team wears DARK.
// Nothing is stored — it's worked out from home_team/away_team on the game, so
// the two teams in one game can never end up in the same color.

// "2026-10-11" + 7 days → "2026-10-18". Done in UTC so DST can't shift the day.
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "9:00 AM" → 540, "1:30 PM" → 810, "13:30" → 810. Times are text on the
// schedule, and sorting them as text puts "10:00 AM" before "9:00 AM", so
// turn them into minutes after midnight first. Unreadable → sorts last.
function minutes(t) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?/i.exec(String(t || ""));
  if (!m) return 24 * 60;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); // 12 AM → 0, 12 PM → 12
  return h * 60 + Number(m[2] || 0);
}

// All of a team's games, in play order: by date, then time, then week number
// (week number alone is the fallback for games that have no date yet).
export function teamGames(games, team) {
  if (!team) return [];
  return games
    .filter((g) => g.home_team === team || g.away_team === team)
    .sort((a, b) =>
      String(a.date || "9999").localeCompare(String(b.date || "9999")) ||
      minutes(a.time) - minutes(b.time) ||
      (Number(a.week) || 0) - (Number(b.week) || 0));
}

// The games that matter for a check-in during `weekISO` (the Sunday that
// starts the check-in week, e.g. "2026-10-11"). A team can play twice in a
// day — and be home in one, away in the other — so this is a LIST:
//   1. every game the team has inside that week, else
//   2. every game on its next game date after that week (bye week), else
//   3. its first game overall (no week given, or no dates on the schedule).
// Returns [] when the team has no games at all.
export function gamesForWeek(games, team, weekISO) {
  const tg = teamGames(games, team);
  if (!tg.length) return [];
  if (weekISO) {
    const end = addDays(weekISO, 7);
    const inWeek = tg.filter((g) => g.date && g.date >= weekISO && g.date < end);
    if (inWeek.length) return inWeek;
    const upcoming = tg.find((g) => g.date && g.date >= weekISO);
    if (upcoming) return tg.filter((g) => g.date === upcoming.date);
  }
  return [tg[0]];
}

// Just the first of those games (or null) — what the single Field / Jersey
// boxes show.
export function gameForWeek(games, team, weekISO) {
  return gamesForWeek(games, team, weekISO)[0] || null;
}

// "light" for the home side, "dark" for the away side, "" if not in the game.
export function jerseyFor(game, team) {
  if (!game || !team) return "";
  if (game.home_team === team) return "light";
  if (game.away_team === team) return "dark";
  return "";
}
