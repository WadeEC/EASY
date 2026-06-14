// Heuristic team builder (FR-2), driven by configurable RULES:
//  - keep_together { field }  → players sharing that field's value share a team
//      (field "__siblings__" = shared last name → FR-2.5)
//  - balance { field }        → spread that numeric field evenly across teams
//                               (e.g. age → FR-2.7, a skill/ranking → FR-2.10)
// Plus: even number of teams (FR-2.3) and a roster-size target (FR-2.8).
// Coaches (FR-2.4 / 2.6) come once coach data is entered.

const num = (x) => Number(x) || 0;
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const teamNum = (name) => parseInt(String(name).replace(/\D/g, ""), 10) || 0;

export function lastName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return (parts.length > 1 ? parts[parts.length - 1] : parts[0] || "").toLowerCase();
}

function keyFor(p, field) {
  if (field === "__siblings__") return lastName(p.name || p.full_name);
  const v = p[field];
  return v == null || v === "" ? "" : String(v).toLowerCase();
}

const isHead = (c) => /head/i.test((c && c.role) || "");

export function buildTeams(players, opts = {}) {
  const rules = opts.rules || [];
  const keepFields = rules.filter((r) => r.type === "keep_together").map((r) => r.field);
  const balanceField = (rules.find((r) => r.type === "balance") || {}).field || "age";
  const coaches = opts.coaches || [];

  // Even number of teams (FR-2.3) — no byes.
  const n = players.length;
  let count = opts.numTeams ? Number(opts.numTeams) : Math.round(n / (opts.targetSize || 10));
  count = Math.max(2, count || 2);
  if (count % 2 !== 0) count += 1;

  const teams = Array.from({ length: count }, (_, i) => ({ name: `Team ${i + 1}`, players: [], coaches: [], mSum: 0 }));

  // 1) Seat COACHES FIRST, evenly (FR-2.4/2.6). Head coaches are placed round-robin so the
  //    spread never differs by more than one — i.e. no team gets a second head coach while
  //    another has none. Assistant coaches are then spread round-robin the same way.
  const heads = coaches.filter(isHead);
  const assts = coaches.filter((c) => !isHead(c));
  heads.forEach((c, i) => teams[i % count].coaches.push(c));
  assts.forEach((c, i) => teams[i % count].coaches.push(c));

  // Pin each coach's child(ren) (matched by name) to the coach's team, so rosters build around them.
  // The Child's name field accepts one or more names separated by commas, semicolons, slashes, or "and",
  // so a coach with two or three kids in the program can keep all of them on the same team.
  // Admins can turn this off via the "Keep each coach's child on their team" toggle (opts.coachChild === false).
  const pinned = {}; // player name (lowercased) -> team index
  const splitKids = (s) => String(s || "")
    .split(/\s*(?:,|;|\/|\band\b|&)\s*/i)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (opts.coachChild !== false) teams.forEach((t, ti) => t.coaches.forEach((c) => {
    for (const ck of splitKids(c.child)) pinned[ck] = ti;
  }));
  // Explicit coach_player links — pin attached players to their coach's team. We map coach id ->
  // team index from the coach placements above, then pin each linked player by name (the same key
  // the unit-placement loop reads). Layered AFTER the legacy child_name pinning so explicit links
  // can add to (not override) it.
  if (opts.links && opts.links.coachAttach) {
    const coachToTeamIdx = {};
    teams.forEach((t, ti) => t.coaches.forEach((c) => { coachToTeamIdx[c.id] = ti; }));
    for (const cid of Object.keys(opts.links.coachAttach)) {
      const ti = coachToTeamIdx[Number(cid)];
      if (ti == null) continue;
      for (const pid of opts.links.coachAttach[cid]) {
        const idx = players.findIndex((p) => p.id === pid);
        if (idx >= 0) {
          const playerKey = String(players[idx].name || players[idx].full_name || "").trim().toLowerCase();
          if (playerKey) pinned[playerKey] = ti;
        }
      }
    }
  }

  // 2) Group players into placement "units" via union-find over all keep_together rules.
  const parent = players.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (const field of keepFields) {
    const buckets = {};
    players.forEach((p, i) => { const k = keyFor(p, field); if (k) (buckets[k] = buckets[k] || []).push(i); });
    for (const arr of Object.values(buckets)) for (let j = 1; j < arr.length; j++) union(arr[0], arr[j]);
  }
  // Explicit positive links (sibling/coach_player/carpool) — union by player id, in addition to
  // the keep_together rules above. Players not in the current scope are silently ignored.
  if (opts.links && Array.isArray(opts.links.positive)) {
    const indexById = new Map();
    players.forEach((p, i) => indexById.set(p.id, i));
    for (const group of opts.links.positive) {
      const idxs = (group || []).map((pid) => indexById.get(pid)).filter((x) => x != null);
      for (let j = 1; j < idxs.length; j++) union(idxs[0], idxs[j]);
    }
  }
  const byRoot = {};
  players.forEach((p, i) => { const r = find(i); (byRoot[r] = byRoot[r] || []).push(p); });
  const unitArrays = Object.values(byRoot);
  // Tag each player with their keep-together unit id, so the UI can move whole units (siblings,
  // link groups) together when dragging — never splitting a locked group by hand.
  unitArrays.forEach((members, gi) => members.forEach((m) => { m._u = gi; }));
  const units = unitArrays.map((members) => {
    let forced = -1; // a unit containing a coach's child is forced onto that coach's team
    for (const m of members) { const k = String(m.name || m.full_name || "").trim().toLowerCase(); if (k in pinned) { forced = pinned[k]; break; } }
    if (forced >= 0) members.forEach((m) => { m._pin = true; }); // coach's child (+ anyone kept with them) — never auto-move
    return { members, size: members.length, metric: avg(members.map((m) => num(m[balanceField]))), forced };
  });

  // 3a) Place coach-child units onto their coach's team first.
  for (const u of units) if (u.forced >= 0) { const t = teams[u.forced]; for (const m of u.members) { t.players.push(m); t.mSum += num(m[balanceField]); } }

  // A "cap" rule (e.g. all-stars) marks special players to spread evenly so no team becomes a
  // "super-team". isStar(p) is true when that player's capped field is set.
  const cap = rules.find((r) => r.type === "cap") || null;
  const capField = cap ? cap.field : null;
  const isStar = (p) => (capField ? !!p[capField] : false);
  const isLow = (p) => !!p._low;                 // low attendance / availability so far
  const starCount = teams.map((t) => t.players.filter(isStar).length);
  const lowCount = teams.map((t) => t.players.filter(isLow).length);

  const lightestByStars = () => { let b = 0; for (let i = 1; i < teams.length; i++) if (starCount[i] < starCount[b] || (starCount[i] === starCount[b] && teams[i].players.length < teams[b].players.length)) b = i; return b; };
  const lightestByLow = () => { let b = 0; for (let i = 1; i < teams.length; i++) if (lowCount[i] < lowCount[b] || (lowCount[i] === lowCount[b] && teams[i].players.length < teams[b].players.length)) b = i; return b; };
  const lightestByLoad = () => {
    let b = 0;
    for (let i = 1; i < teams.length; i++) {
      const li = teams[i], lb = teams[b];
      if (li.players.length < lb.players.length) b = i;
      else if (li.players.length === lb.players.length) { const ai = li.players.length ? li.mSum / li.players.length : 0, ab = lb.players.length ? lb.mSum / lb.players.length : 0; if (ai < ab) b = i; }
    }
    return b;
  };
  // Seat a whole unit on team bi, keeping the all-star and low-availability tallies current.
  const seat = (bi, u) => { const t = teams[bi]; for (const m of u.members) { t.players.push(m); t.mSum += num(m[balanceField]); if (isStar(m)) starCount[bi]++; if (isLow(m)) lowCount[bi]++; } };

  const rest = units.filter((u) => u.forced < 0);
  const starUnits = rest.filter((u) => u.members.some(isStar));
  const lowUnits = rest.filter((u) => !u.members.some(isStar) && u.members.some(isLow));
  const plainUnits = rest.filter((u) => !u.members.some(isStar) && !u.members.some(isLow));
  // 3b) Spread all-star units evenly — the team with the fewest all-stars gets the next.
  for (const u of starUnits.sort((a, b) => b.size - a.size)) seat(lightestByStars(), u);
  // 3c) Spread low-availability units evenly so no team is starved of reliable bodies.
  for (const u of lowUnits.sort((a, b) => b.size - a.size)) seat(lightestByLow(), u);
  // 3d) Build the rest of the rosters around them: biggest groups first, each to the lightest team.
  for (const u of plainUnits.sort((a, b) => b.size - a.size || a.metric - b.metric)) seat(lightestByLoad(), u);

  // 4) Do-not-link enforcement: try to resolve each forbidden pair on the same team by moving
  // one of the two players to a team that doesn't contain the partner. Unmovable players (pinned
  // coach-children, members of larger same-unit groups) are skipped and the pair surfaces as a
  // conflict the admin must resolve manually.
  const conflicts = [];
  if (opts.links && Array.isArray(opts.links.doNotLink) && opts.links.doNotLink.length) {
    const dnlPairs = [];
    for (const group of opts.links.doNotLink) {
      const g = group || [];
      for (let a = 0; a < g.length; a++) for (let bb = a + 1; bb < g.length; bb++) dnlPairs.push([g[a], g[bb]]);
    }

    const findTeam = (pid) => teams.findIndex((t) => t.players.some((p) => p.id === pid));
    const tryResolve = (pidA, pidB) => {
      const ta = findTeam(pidA);
      const tb = findTeam(pidB);
      if (ta < 0 || tb < 0 || ta !== tb) return true; // ok — not co-located
      // Try moving one of the pair to a team without the other.
      for (const pid of [pidA, pidB]) {
        const pl = teams[ta].players.find((p) => p.id === pid);
        if (!pl || pl._pin || pl._u === undefined) continue;
        // Same-unit teammates would have to move too; skip unit moves for now.
        const sameUnit = teams[ta].players.filter((p) => p._u === pl._u);
        if (sameUnit.length > 1) continue;
        const partnerId = pid === pidA ? pidB : pidA;
        const target = teams.findIndex((t, ti) => ti !== ta && !t.players.some((p) => p.id === partnerId));
        if (target < 0) continue;
        teams[ta].players = teams[ta].players.filter((p) => p.id !== pid);
        teams[target].players.push(pl);
        return true;
      }
      return false;
    };

    for (const [a, b] of dnlPairs) {
      const resolved = tryResolve(a, b);
      if (!resolved) {
        const ta = findTeam(a);
        conflicts.push({ kind: "do_not_link", players: [a, b], team: teams[ta]?.name || "" });
      }
    }
  }

  teams.sort((a, b) => teamNum(a.name) - teamNum(b.name));
  const out = teams.map((t) => ({
    name: t.name,
    players: t.players,
    coaches: t.coaches,
    size: t.players.length,
    ageAvg: t.players.length ? +avg(t.players.map((p) => num(p.age))).toFixed(1) : 0,
    balanceField,
    metricAvg: t.players.length ? +(t.mSum / t.players.length).toFixed(1) : 0,
  }));
  return { teams: out, conflicts };
}
