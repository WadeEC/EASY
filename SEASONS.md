# Seasons, Unassigned, Migration & Export

What changed, why, and what to click. Nothing in this update deletes data.

---

## 1. A season is now a real thing, not a label

**Before:** every player, game and division lived in one pile. "Which season?"
was a filter that each page applied — or forgot to apply. A page that forgot
showed you last year's kids mixed in with this year's, and it looked identical
to a page that hadn't.

**Now:** every record that belongs to a season carries that season in a real,
indexed database column. The filtering happens in SQL, once, for every read in
the app. A page cannot forget.

These belong to exactly one season and are never shared:

| | |
|---|---|
| players | coaches |
| teams | referees |
| divisions | games / schedule |
| attendance | tournaments |
| roster locks | schedule blackouts |
| **the master sheet** | |

These stay organization-wide on purpose, because they are settings rather than
data: sections, fields, assignment rules, team-building rules, home flags, and
user accounts.

### The season picker means one of four things

The sidebar picker is sent with every single request. Its vocabulary is now
explicit, so "all seasons" and "nobody set a season" can't be confused:

| Picker | Meaning |
|---|---|
| `Fall 2026` | that season only |
| `All seasons` | every season, deliberately combined |
| `No season (legacy)` | records from before seasons existed |
| *(not sent)* | falls back to the current season — never to "everything" |

Under the picker there is now a line saying what you're looking at and how many
players are in it. A locked season shows 🔒.

---

## 2. Managing seasons

There is no Seasons settings page — season work happens where you already are.

**Switching seasons** is the sidebar picker. It shows each season's player
count and a 🔒 on a locked one, and the line underneath says what the numbers
on screen cover.

**Starting, locking, archiving a season, and moving players between seasons**
are S-Dot jobs:

| Say | What happens |
|---|---|
| "start Fall 2027 with the same leagues" | new empty season, made current, divisions copied if you ask |
| "lock Fall 2023" | that season goes read-only — every write path refuses it |
| "bring last year's Limerick kids into Fall 2027" | previews the count, then enrolls on your say-so |
| "what still needs fixing across seasons?" | the cleanup report — orphans, unused dropdown choices, stray leagues |
| "which seasons has Jayden played?" | follows the enrollment lineage |

Each of those is a real tool with the same guards the page had: enrollment
previews first, a locked season refuses, and nothing is deleted.

**Exporting** now sits on the two pages you'd reach for it from — see §5.

---

## 3. Unassigned (new page, under Season)

"Unassigned" used to be a bucket at the bottom of a few lists, and it meant
something slightly different on each one. It now means one thing, in the season
on screen, split into the three problems that need three different fixes:

| Bucket | What it means | Usual fix |
|---|---|---|
| **No league yet** | nobody has routed them | assignment rules, or set the league |
| **No age division** | in a league, no age bracket | almost always an age outside every bracket |
| **No team** | in a division, not placed | run the team build, or drop them on a team |

Select any number of players and set league / division / team in one go. The
result tells you both halves — `Moved 12 · 3 blocked: Roster for "…" is locked` —
because the blocked ones are the part you have to act on.

---

## 4. Moving players between seasons

Registering a returning kid is **enrollment**, and enrollment **copies forward**:

- A **new** record is created in the target season.
- The old season's record is **not touched**. Its roster, teams, standings and
  reports stay exactly as they were.
- The new record carries name, age, township, phone, key tag and jersey size.
- It does **not** carry team, division, rank, all-star or jersey status — those
  are last season's answers. They land in the new season's **Unassigned**.
- `enrolled_from_season` / `enrolled_from_id` record where they came from, which
  is how "which seasons has Jayden played?" is answerable.

Anyone already in the target season is skipped, so running it twice is safe.

Always **Preview** first — it tells you the count and shows a sample before
anything is written.

> A plain move (league / division / team) can no longer change a season at all.
> It returns: *"Use 'enroll in season' to move a player between seasons — a plain
> move can't change the season."* That's deliberate: a season change that looked
> like a move is how a roster silently loses a player.

---

## 5. Excel and CSV export

**Teams**, at the bottom, and **Master Spreadsheet**, under the download
buttons. Pick either one league or the whole season, then a format. It always
exports the season in the sidebar picker; on "All seasons" it says to pick one
rather than blending two.

A **league workbook** (`.xlsx`) has seven tabs:

| Tab | Contents |
|---|---|
| Roster | every player with their placement and contact details |
| Unassigned | the three buckets, labelled by problem |
| Teams | one row per team: size, average age, coaches, full roster |
| Coaches | with role, type and team |
| Schedule | week, date, time, field, matchup, score |
| Standings | W-L-T, points for/against, differential |
| Master Sheet | the raw imported rows for that league, this season |

A **season workbook** has a summary tab, all players, unassigned, one roster tab
per league, plus schedule, coaches and master.

**CSV** comes two ways: `All tabs as CSV (.zip)` gives you the same seven sheets
as separate files, and `Roster only (.csv)` gives you the single flat file.

Every filename names its season — `Fall-2027-Saturday-Limerick.xlsx` — so a file
sitting in Downloads can't be mistaken for another year's. The master sheet has
its own download button that carries the season too.

You can also ask S-Dot: *"export Saturday Limerick as Excel"* and it hands back
a download link.

---

## 6. Cleanup

Ask S-Dot *"what still needs fixing across seasons?"* and it reports three
things:

1. **Records with no season** — they'd otherwise only appear under
   "No season (legacy)". S-Dot can assign them all to a season you name.
2. **Per season** — unassigned counts, and any league appearing on players that
   the season doesn't claim.
3. **Choices nothing uses** — dropdown options no record has ever had. It found
   `Wedn` on the league list in your database, for example. Nothing is deleted
   automatically; clean them up on Leagues & Assignment when you're ready.

### What the upgrade did to your database on first launch

Migrations run once, at startup, and are recorded in a `schema_migrations`
table:

| Migration | Effect on your data |
|---|---|
| `001` | added the `season` column + indexes |
| `002` | blackouts are now unique per (date, league, **season**) |
| `003` | roster locks are now per (**season**, league) |
| `004` | copied the season out of each record's JSON into the new column — **414 records** |
| `005` | registered `Fall 2023` and `Fall 2026` in the new seasons table |
| `006` | **15 records** (6 divisions, 8 attendance, 1 referee) had no season; since Fall 2023 was the only season with players, they were given to Fall 2023 |
| `007` | kept each record's JSON in step with its column |
| `008` | made sure a current season is set |

Migration `006` only runs when the answer is unambiguous — exactly one season
holds players. With two or more it does nothing and the records show up in the
Cleanup report instead, because guessing is the thing we're removing.

---

## 7. S-Dot no longer answers about the wrong season

Four changes, in the order they matter:

**Every read tool it can call is season-scoped.** It is not trusted to remember
to filter; it can't reach another season's rows unless it names that season.

**The season is in its prompt on every turn**, along with the live per-season
counts read fresh from the database. It's told to quote those and nothing else.

**It has to name the season in any answer with a number in it** — "Fall 2026 has
304 players", never "we have 304 players".

**Four new accuracy rules:**

- Never state a number it didn't read from a tool call *this turn*. Not from the
  conversation, not from the page, not from a moment ago.
- Never invent a person. If a search finds nothing, the answer is "I can't find
  anyone by that name in Fall 2026" — not a plausible-looking record.
- Report what actually happened. If a write comes back with an error, relay the
  error and don't describe the change as done. If it enrolled 304 and skipped
  12, say both.
- When it doesn't know, say so.

New things it can do: `list_seasons`, `start_season`, `set_active_season`,
`set_season_lock`, `enroll_players_in_season` (dry-run first, always),
`player_season_history`, `unassigned_report`, `season_cleanup_report`,
`export_league`. `move_player` can now move someone to a **team**, and refuses a
team in a different division than the player's.

---

## 7b. Editing the schedule with S-Dot

Yes — and it now has tools sized to the change, instead of only "rebuild the
whole thing".

| You say | What it does |
|---|---|
| "move Team 3's Saturday game to Field 2 at 10" | `find_games` → `edit_game` |
| "Team 1 beat Team 4, 21–14" | `find_games` → `set_game_score` |
| "add a make-up game next Saturday" | `add_game` |
| "cancel the 9am game" | `find_games` → `delete_game` |
| "push everything on the 19th to the 26th" | `reschedule_date` (previews first) |
| "the 12th got rained out" | `preview_rainout` → `apply_rainout` (cascades) |
| "block off Halloween weekend" | `add_blackout` |
| "build the schedule" | `generate_schedule` (rebuilds — it says so) |

`find_games` searches the way you'd describe a game — by team, date, week,
field or league — and returns ids. S-Dot has to call it before editing; it
can't guess a game id, and if your description matches more than one game it
lists them and asks which.

`edit_game` changes only the values you name and refuses the rest: a date
that's blacked out for that league, a malformed time, a team playing itself, a
score (that's `set_game_score`), or anything in a locked season.

**Two bugs I found while checking this, both fixed:**

`setGameScore`, `rescheduleDate`, the team-build save, and a few others called
the update and then returned `ok: true` **without looking at whether the write
succeeded**. On a locked season the data was correctly protected, but the app
reported success — and S-Dot would have faithfully repeated that to you. Every
one of those now checks the result and reports what was actually refused,
including partial results ("saved 118, 2 blocked").

Worse: `bulk_update_field`, `sequence_field`, `reassign_all`,
`rename_field_option` and `update_division` wrote **straight to SQL**, skipping
the season lock entirely — so a bulk action really could rewrite a locked
season. All five now go through the one guarded write path.

---

## 7c. Navigation

The sidebar order now follows the shape of a Saturday:

One open group, three hub buttons:

| | |
|---|---|
| **Main** | Players & Coaches · Teams · Unassigned · Schedule · Leagues & Assignment |
| ▣ **Stations** | one button → a page |
| 🏆 **Season** | one button → a page |
| ⚙️ **Settings** | one button → a page |

Main is everything you touch to run the thing, always visible. The three hub
buttons each open a page of cards with a line saying what every destination is
for:

- **Stations** (scan viewfinder) — Team Board, Kiosk, Attendance
- **Season** (trophy) — Standings & Scores, Tournaments, Player Rankings, Raffle
- **Settings** (gear) — Master Spreadsheet, Users, Change log, Time Machine, Advanced

These are pages you reach for occasionally and want to be sure about. A
collapsed list of bare names couldn't tell you which one you wanted; a card
with a sentence on it can, and a page has room for one.

The Team Board hides the sidebar (it's meant for the big screen at the table),
so its way out now returns to **Stations** rather than all the way to the
dashboard — a hub is only useful if you can get back to it.

Nothing appears in two places: every item was removed from where it used to
live. **Sections** now holds only custom sections you've added yourself, and
hides entirely when there are none — which, on your data, means it doesn't
show at all.

---

## 7d. First and last name on the master sheet

The master sheet leads with **First Name** and **Last Name** columns, in the
table and in every export.

Districts export names in whatever shape their software feels like: one "Player
Name" column, separate First/Last columns, or "Last, First". The master sheet
now settles that for you:

- a sheet that already had First/Last columns is believed as-is;
- otherwise the full name is split — commas (`Brooks, Jayden`), surname
  particles (`Maria de la Cruz` → *de la Cruz*, not *Cruz*), and suffixes
  (`Robert Kielkopf Jr.`) are all handled;
- if the imported row has no name at all, it falls back to the matched player
  record rather than showing blank.

It's deliberately conservative: where a name is genuinely ambiguous it keeps the
whole thing in Last rather than inventing a split. A wrong surname on a roster
is worse than an awkward one.

There's also a **By last name** sort toggle next to the row count, and the
search box now matches on the split names too.

---

## 7e. Attendance

Two tabs.

**This week** is a sheet you fill in and save. Every player on the roster is a
row, and the answer is one of four things:

| | |
|---|---|
| **Present** | they were here |
| **Absent** | attendance was taken and they weren't |
| **Excused** | away, told you in advance |
| **not taken** | nobody marked them at all |

That fourth one is the point. Before this there was a tick or a blank, and the
blank meant both "wasn't here" and "we never took attendance" — which made an
exported week impossible to hand to anyone. They're now separate facts, and
`getCheckins` counts only Present, so an absence never inflates a check-in
number.

Each row takes a free-text note ("left at half time", "hamstring"), and every
mark records **when, by whom, and through which door** — kiosk, scan, Team
Board, the sheet, or S-Dot.

Nothing saves until you press **Save**; edited rows are highlighted and the
count sits on the button. Two bulk helpers: **All present**, and **Rest absent**
(fills only the blanks — it never overwrites an answer you already gave).

**Season grid** is the old players × weeks view, still tap-to-toggle.

### Exporting

- **This week** as CSV or Excel — one row per player with status, note, and who
  marked it.
- **Whole season grid** as CSV or Excel — a row per player, a column per week
  (P / A / E), with present and absent totals.

The grid is also now a tab inside the league and season workbooks, so a full
export carries attendance with it.

### It is connected to check-in

You were right that it is — and it still is. Every door writes through one
function (`setCheckin`): the Team Board, the kiosk scanner, the referee kiosk,
the Attendance page and S-Dot. A player scanned in at the gate shows as Present
here immediately, tagged `via: scan`. I verified each path end to end.

A locked season refuses attendance edits like everything else, and the Save
button reports what was refused instead of claiming success.

---

## 7f. Building a schedule is now seven steps

The build form used to put nine controls on screen at once with no hint which
mattered first. The usual result was filling everything in, pressing Generate,
and being told a field was missing — after the fact, at the bottom.

It's now a wizard with a clickable rail across the top and Back / Next arrows:

| | | |
|---|---|---|
| **1** | League | picked first — everything after belongs to it |
| **2** | Fields | where this league plays |
| **3** | Teams | who's in, guest teams included |
| **4** | Dates | first game date, weeks of games |
| **5** | Game day | games per team, slot length, first-game time per division |
| **6** | Blackout dates | weekends to skip — was buried in a card below the form |
| **7** | Review & generate | every answer listed with a **Change** link, then Generate |

**The league comes first and gates the rest.** Fields, teams, divisions and
blackouts all belong to one league, so choosing it last meant every earlier
answer was given against nothing in particular. Steps 2–7 now say "Pick a
league on step 1 first" with a link back, rather than showing controls that
quietly do nothing.

Changing the league on step 1 clears the fields and team choices — they belong
to the league you were building for, and silently carrying them into a
different one is how a schedule ends up made of another league's parts.

**Next is blocked until the step is answered**, and the reason sits between the
arrows — "Add at least one field", "Set a first-game time for: Ages 4-6,
Ages 7-8". The error arrives where you can act on it instead of after you press
the button.

A step only shows a green tick once you've moved past it, so a tick always
means "you've dealt with this" and never "we assumed this was fine". Steps 3
and 5 are optional — no start date and no blackouts are both valid answers —
but they still have to be walked through.

The rail is clickable, so you can jump straight back to a step. The Review
screen lists every setting, including how many blackout dates are in play, each
with a Change link to the step that owns it.

**Ask S-Dot stays below the wizard on every step**, so you can still skip the
whole thing with "make a season schedule for Saturday Limerick starting in
September".

---

## 7g. Bulk changes, and the "delete 14 of 302" bug

**What happened.** Asked to *"delete every player in Saturday Limerick"*, S-Dot
offered to delete **14** players. The league has **302**.

**Why.** Every turn, S-Dot was sent a snapshot of the screen — up to 120 DOM
elements with their text — stringified and then chopped at 3,500 characters.
What survived the chop was a broken fragment of JSON full of player names. Asked
for a count, the model counted the names it could see. Fourteen of them fitted.

It was never a hallucination in the usual sense. The number came from something
real; it was just a slice of one scrolled page being read as a total.

**Three fixes.**

**1. The screen is a map, not data.** The context block is now budgeted *before*
being stringified, so the JSON is always valid and states how much it left out
(`60 of 240 elements`). It keeps only things you can act on — buttons, links,
inputs — not table rows. And it's labelled: *never count these, never read
record values out of them.*

**2. Counts come from the database.** New `count_matching` tool — how many
records match a league / division / team / field condition, in the season on
screen, read in SQL. S-Dot must call it before quoting any total.

**3. A bulk delete cannot delete a different number than the one you agreed to.**

New `bulk_delete_records` and `clear_league`. Both take an `expect_count` — the
number S-Dot told you — and **re-count at execution time**. If the two disagree,
nothing is deleted and the error names both numbers:

> Count mismatch — you asked to delete 14, but 304 record(s) actually match
> right now. Nothing was deleted.

Called with no count at all, it refuses and tells you the real one. A locked
season refuses the whole batch rather than deleting half of it. Every deletion
is audited individually, so the Change Log lists them and **Time Machine puts
them all back** — I deleted 110 players and restored all 110.

### What S-Dot can do in bulk now

| You say | Tool |
|---|---|
| "how many players in Saturday Limerick?" | `count_matching` |
| "delete every player in Saturday Limerick" | `count_matching` → `bulk_delete_records` |
| "clear out Saturday Limerick" (players, coaches, games) | `count_league_contents` → `clear_league` |
| "move the 11-12s to Sunday Upper Merion" | `bulk_move_players` |
| "set every blank jersey size to YM" | `bulk_update_field` |
| "bring last year's Limerick kids into Fall 2027" | `enroll_players_in_season` (previews first) |
| "number everyone from 1001" | `sequence_field` |

Its instructions now say: never loop a single-record tool more than about five
times, never delete as a way of moving someone, and never soften a deletion —
*"permanently delete 302 players"*, with the count.

---

## 8. What to check first

1. Start the app. The migration runs on first request — watch for nothing
   unusual in the terminal.
2. Ask S-Dot "how many players in each season?" — Fall 2023 should be 414 with
   6 divisions and 414 master rows, Fall 2026 zero of everything.
3. Switch the sidebar to **Fall 2026** → every page should be empty. That empty
   is the whole point.
4. Ask S-Dot "what still needs fixing across seasons?" — no orphans, and it
   should flag `Wedn`.
5. Teams → Export → Fall 2023 / Saturday Limerick as Excel, and open it.
6. Lock Fall 2023, try to move a player, confirm the refusal, unlock it.
7. Ask S-Dot "how many players do we have?" on each season and check it names
   the season in the answer.
8. Ask S-Dot to move one game ("put Team 1's first game on Field 3") and check
   it looks the game up before changing it.
9. Master Spreadsheet → confirm First Name / Last Name lead the table and the
   splits look right on any unusual names.
10. Attendance → This week → mark a few, Save, then Download this week (CSV) and
   open it. Then scan someone in at the Kiosk and confirm they turn Present here.
11. Schedule → Build schedule → walk the seven steps. Check Next refuses to move
   on from an unanswered step, and that Review lists what you entered.
12. Ask S-Dot "how many players in Saturday Limerick?" — it must match the count
   on the Players page. Then "delete every player in Saturday Limerick" and
   check the number it quotes before you confirm anything.
