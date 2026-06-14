// Round-robin season schedule (circle method).
// buildSchedule(teamNames, { weeks, gamesPerDay }) -> array of weeks; each week is an
// array of { home, away }. Each team plays `gamesPerDay` games per week (default 1).
// The season runs for `weeks` weeks (default: one full round-robin). If it runs longer
// than a single round-robin, the cycle repeats with home/away flipped for fairness.
// An odd number of teams gets a rotating bye (that team sits out that round).

const BYE = "(bye)";

// One full round-robin: an array of rounds, each round an array of { home, away }.
function roundRobinRounds(teams) {
  const order = [...teams];
  if (order.length % 2) order.push(BYE);
  const n = order.length;
  const half = n / 2;
  const rounds = [];
  let row = [...order];
  for (let r = 0; r < n - 1; r++) {
    const games = [];
    for (let i = 0; i < half; i++) {
      let home = row[i];
      let away = row[n - 1 - i];
      if (home === BYE || away === BYE) continue;
      if (r % 2 === 1) { const t = home; home = away; away = t; }
      games.push({ home, away });
    }
    rounds.push(games);
    row = [row[0], row[n - 1], ...row.slice(1, n - 1)]; // rotate, keeping the first fixed
  }
  return rounds;
}

export function buildSchedule(teamNames, opts = {}) {
  const teams = [...new Set((teamNames || []).map((t) => String(t)).filter(Boolean))];
  if (teams.length < 2) return [];
  const base = roundRobinRounds(teams);
  const perDay = Math.max(1, Math.floor(Number(opts.gamesPerDay) || 1));
  const fullWeeks = Math.max(1, Math.ceil(base.length / perDay)); // weeks to finish one round-robin
  const weeks = Math.max(1, Math.floor(Number(opts.weeks) || fullWeeks));
  const days = [];
  for (let w = 0; w < weeks; w++) {
    const games = [];
    for (let r = 0; r < perDay; r++) {
      const idx = w * perDay + r;
      const cycle = Math.floor(idx / base.length);
      const round = base[idx % base.length];
      games.push(...(cycle % 2 === 1 ? round.map((g) => ({ home: g.away, away: g.home })) : round));
    }
    days.push(games);
  }
  return days;
}

// How many weeks a single full round-robin needs at the given games-per-day (for UI hints).
export function fullSeasonWeeks(teamCount, gamesPerDay = 1) {
  if (teamCount < 2) return 0;
  const rounds = teamCount % 2 === 0 ? teamCount - 1 : teamCount;
  return Math.max(1, Math.ceil(rounds / Math.max(1, Math.floor(gamesPerDay || 1))));
}

// Place one week's games onto fields + time slots with NO clashes:
//  - at most one game per field per time slot (a field hosts one game at a time), and
//  - no team is in two games in the same time slot (a team can't be two places at once).
// Games rotate across fields; the clock only advances once every field in a slot is in use.
// With no fields given, games fall back to one-per-slot in sequence (also clash-free).
export function placeOnFields(games, fields, startTime, gap = 0) {
  const list = games || [];
  const F = (fields || []).length;
  if (!F) return list.map((g, i) => ({ ...g, time: clockTime(startTime, i * gap), location: "" }));
  const slots = []; // each: { used:Set<field>, teams:Set<team> }
  const placed = [];
  for (const g of list) {
    let s = 0, field = null, found = false;
    for (; s < slots.length; s++) {
      const sl = slots[s];
      if (sl.used.size >= F) continue;                          // field full this slot
      if (sl.teams.has(g.home) || sl.teams.has(g.away)) continue; // a team already plays this slot
      field = fields.find((f) => !sl.used.has(f)); found = true; break;
    }
    if (!found) { s = slots.length; slots.push({ used: new Set(), teams: new Set() }); field = fields[0]; }
    const sl = slots[s];
    sl.used.add(field); sl.teams.add(g.home); sl.teams.add(g.away);
    placed.push({ ...g, _slot: s, time: clockTime(startTime, s * gap), location: field });
  }
  placed.sort((a, b) => (a._slot - b._slot) || (fields.indexOf(a.location) - fields.indexOf(b.location)));
  return placed.map(({ _slot, ...g }) => g);
}

export function weekDate(startISO, weekIndex, blackoutSet = null) {
  if (!startISO) return "";
  let d = new Date(startISO.length <= 10 ? startISO + "T00:00:00" : startISO);
  if (isNaN(d.getTime())) return "";
  if (!blackoutSet || blackoutSet.size === 0) {
    d.setDate(d.getDate() + 7 * weekIndex);
    return d.toISOString().slice(0, 10);
  }
  // Walk forward 7 days at a time, skipping any date in the blackout set.
  // weekIndex 0 = the first non-blackout date >= startISO.
  let used = 0;
  for (let safety = 0; safety < 520; safety++) {
    const iso = d.toISOString().slice(0, 10);
    if (!blackoutSet.has(iso)) {
      if (used === weekIndex) return iso;
      used++;
    }
    d.setDate(d.getDate() + 7);
  }
  return d.toISOString().slice(0, 10);
}

// A 12-hour clock time `offsetMin` minutes after a "HH:MM" start (e.g. clockTime("09:00", 75) -> "10:15 AM").
export function clockTime(startHHMM, offsetMin = 0) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(startHHMM || ""));
  if (!m) return "";
  let total = (+m[1]) * 60 + (+m[2]) + (Number(offsetMin) || 0);
  total = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60), mm = total % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = (h % 12) || 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ap}`;
}
