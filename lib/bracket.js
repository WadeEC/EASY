// Single-elimination bracket engine (pure, client-safe).
// A match: { home, away, winner, score, field, time, ref }. "(bye)" means an empty slot.
// Rounds: rounds[0] = first round; each later round is half the size; match i in round r
// is fed by matches 2i and 2i+1 from round r-1.
import { clockTime } from "./schedule.js";

const mkMatch = (home, away) => ({ home: home || "", away: away || "", winner: null, score: "", field: "", time: "", ref: "" });
const isBye = (m) => m.home === "(bye)" || m.away === "(bye)";

// Standard bracket seeding for a power-of-two size: returns seed numbers in slot order
// so that 1 meets the lowest seed, top seeds can't meet until late, etc.
export function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next = [];
    for (const s of order) { next.push(s); next.push(sum - s); }
    order = next;
  }
  return order;
}

// Winner of a match: the recorded winner, or the lone team when the other side is a bye.
export function winnerOf(m) {
  if (!m) return "";
  if (m.winner) return m.winner;
  if (m.away === "(bye)" && m.home && m.home !== "(bye)") return m.home;
  if (m.home === "(bye)" && m.away && m.away !== "(bye)") return m.away;
  return "";
}

// Build the whole bracket from a seeded list of team names (index 0 = seed 1).
export function buildRounds(teams) {
  const list = (teams || []).map((t) => String(t).trim()).filter(Boolean);
  const n = list.length;
  if (n < 2) return [];
  let size = 1; while (size < n) size *= 2;
  const order = seedOrder(size);
  const r0 = [];
  for (let p = 0; p < size; p += 2) {
    const a = order[p], b = order[p + 1];
    r0.push(mkMatch(a <= n ? list[a - 1] : "(bye)", b <= n ? list[b - 1] : "(bye)"));
  }
  const rounds = [r0];
  let count = r0.length;
  while (count > 1) { count = Math.floor(count / 2); rounds.push(Array.from({ length: count }, () => mkMatch("", ""))); }
  return recompute(rounds);
}

// Fill every later round from the winners of the round before it, clearing any
// now-invalid downstream winner/score (e.g. after a result is changed).
export function recompute(rounds) {
  for (let r = 1; r < rounds.length; r++) {
    for (let i = 0; i < rounds[r].length; i++) {
      const home = winnerOf(rounds[r - 1][2 * i]);
      const away = winnerOf(rounds[r - 1][2 * i + 1]);
      const m = rounds[r][i];
      m.home = home; m.away = away;
      if (m.winner && m.winner !== home && m.winner !== away) { m.winner = null; m.score = ""; }
    }
  }
  return rounds;
}

// Lay matches onto fields + times with no clashes: one game per field per slot, rounds
// run in sequence (round r+1 starts a roundGap after round r finishes). Byes get no game.
export function scheduleRounds(rounds, fields, startTime, slotMins = 60, roundGap = 15) {
  const flds = (fields || []).map((f) => String(f).trim()).filter(Boolean);
  const F = Math.max(1, flds.length);
  const slot = Math.max(0, Number(slotMins) || 0);
  const gap = Math.max(0, Number(roundGap) || 0);
  let offset = 0;
  for (let r = 0; r < rounds.length; r++) {
    let placed = 0;
    for (const m of rounds[r]) {
      if (isBye(m)) { m.field = ""; m.time = ""; continue; }
      const s = Math.floor(placed / F);
      m.field = flds.length ? flds[placed % F] : "";
      m.time = clockTime(startTime, offset + s * slot);
      placed++;
    }
    const slots = Math.max(1, Math.ceil((placed || 1) / F));
    offset += slots * slot + gap;
  }
  return rounds;
}

// Champion once the final has a winner (or "").
export function champion(rounds) {
  if (!rounds || !rounds.length) return "";
  const last = rounds[rounds.length - 1];
  return last.length === 1 ? winnerOf(last[0]) : "";
}

// Human round label from how many matches it holds.
export function roundName(matchCount) {
  if (matchCount === 1) return "Final";
  if (matchCount === 2) return "Semifinals";
  if (matchCount === 4) return "Quarterfinals";
  return `Round of ${matchCount * 2}`;
}
