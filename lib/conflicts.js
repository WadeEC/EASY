// Scheduling-conflict helpers (pure, client-safe). A game object looks like
// { id, week, date, time, league, home, away, location, referee } where referee
// is a comma-separated list of officials. Simultaneity is judged by date + time;
// games missing either can't be compared, so they're skipped.

const norm = (s) => String(s == null ? "" : s).trim();
const refsOf = (g) => norm(g.referee).split(",").map((s) => s.trim()).filter(Boolean);

// Returns { field:[], team:[], referee:[] }. Each entry is { date, time, ...key, games:[] }
// describing two or more games that collide at the same date + time.
export function findConflicts(games) {
  const byTime = {};
  for (const g of games || []) {
    if (!norm(g.date) || !norm(g.time)) continue;
    const k = norm(g.date) + "|" + norm(g.time);
    (byTime[k] = byTime[k] || []).push(g);
  }
  const field = [], team = [], referee = [];
  for (const k of Object.keys(byTime)) {
    const [date, time] = k.split("|");
    const gs = byTime[k];

    const byField = {};
    for (const g of gs) { const f = norm(g.location); if (!f) continue; (byField[f] = byField[f] || []).push(g); }
    for (const f of Object.keys(byField)) if (byField[f].length > 1) field.push({ date, time, location: f, games: byField[f] });

    // A team is identified within its league — leagues with same-named teams (e.g. "Team 1")
    // are different teams, so scope the double-booking check by league.
    const byTeam = {};
    for (const g of gs) for (const t of [norm(g.home), norm(g.away)]) { if (!t) continue; const k = norm(g.league) + "|" + t; (byTeam[k] = byTeam[k] || { team: t, games: [] }).games.push(g); }
    for (const k of Object.keys(byTeam)) if (byTeam[k].games.length > 1) team.push({ date, time, team: byTeam[k].team, games: byTeam[k].games });

    const byRef = {};
    for (const g of gs) for (const r of refsOf(g)) (byRef[r] = byRef[r] || []).push(g);
    for (const r of Object.keys(byRef)) if (byRef[r].length > 1) referee.push({ date, time, referee: r, games: byRef[r] });
  }
  return { field, team, referee };
}

// The other game (if any) where `refName` is already working at this date + time.
// Returns the conflicting game, or null when the ref is free (or time is unknown).
export function refBusyAt(games, refName, date, time, exceptId) {
  if (!norm(refName) || !norm(date) || !norm(time)) return null;
  const rn = norm(refName).toLowerCase();
  for (const g of games || []) {
    if (exceptId != null && g.id === exceptId) continue;
    if (norm(g.date) !== norm(date) || norm(g.time) !== norm(time)) continue;
    if (refsOf(g).some((r) => r.toLowerCase() === rn)) return g;
  }
  return null;
}
