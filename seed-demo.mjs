// Demo data: run once to fill the app with realistic test players.
//   node seed-demo.mjs
// Creates a Players section (if needed), assignment rules, ~44 players across the five
// townships (with sibling families), and one linked "carpool" — then leagues auto-fill.
// To reset: delete league.db and re-run.
import * as T from "./lib/tools.js";

if (!T.getRecordTypes().some((t) => t.name === "player")) T.seedStandardPlayers();

if (T.getRecords("player").length) {
  console.log(`There are already ${T.getRecords("player").length} players. Delete league.db to reset, then re-run.`);
  process.exit(0);
}

// Route players into leagues automatically (FR-2.2: 13+ → Saturday Limerick).
if (!T.getAssignmentRules("player").length) {
  T.createAssignmentRule("Teens → Saturday Limerick", [{ field: "age", op: ">=", value: "13" }], "Saturday Limerick");
  T.createAssignmentRule("Under 13 → Sunday Upper Merion", [{ field: "age", op: "<", value: "13" }], "Sunday Upper Merion");
}

const townships = ["Limerick", "Upper Merion", "Phoenixville", "Payne Township", "Plymouth Township"];
const jerseys = ["YS", "YM", "YL", "AS", "AM", "AL"];
const firsts = ["Alex", "Sam", "Mia", "Jon", "Ana", "Ben", "Eli", "Zoe", "Ray", "Tom", "Liam", "Noah",
  "Ava", "Emma", "Olivia", "Lucas", "Mason", "Ella", "Leo", "Nina", "Maya", "Jack", "Ruby", "Finn",
  "Iris", "Owen", "Lily", "Max", "Cleo", "Kai", "Rosa", "Theo", "June", "Wyatt", "Nora", "Ezra",
  "Hazel", "Milo", "Aria", "Jude", "Cora", "Reed", "Faye", "Gus", "Tess", "Bo", "Wren", "Hugo", "Sage", "Remy"];
const singleLasts = ["Park", "Lopez", "Diaz", "Kim", "Ng", "Fox", "Smith", "Brown", "Reyes", "Walsh",
  "Tran", "Chen", "Flynn", "Bauer", "Hayes", "Webb", "Marsh", "Quinn", "Pope", "Stone", "Dunn", "Frost",
  "Lane", "Vance", "Cruz", "Mora", "Pena", "Roth", "Shaw", "Beck"];
const families = [["Rivera", 3], ["Cole", 2], ["Nguyen", 2], ["Patel", 3], ["Garcia", 2]];

const rnd = (n) => Math.floor(Math.random() * n);
const age = () => 4 + rnd(14);          // 4–17
const jersey = () => jerseys[rnd(jerseys.length)];
let phoneSeed = 5000;
const phone = () => { phoneSeed += rnd(40) + 1; return "610-555-" + String(10000 + phoneSeed).slice(-4); };

const rows = [];
let fi = 0, ti = 0;
for (const [last, kids] of families) {       // siblings: shared last name + shared parent phone
  const fam = phone();
  for (let k = 0; k < kids; k++)
    rows.push({ full_name: `${firsts[fi++]} ${last}`, age: age(), township: townships[ti++ % 5], jersey_size: jersey(), parent_phone: fam });
}
for (let i = 0; i < 30; i++)
  rows.push({ full_name: `${firsts[fi++]} ${singleLasts[i % singleLasts.length]}`, age: age(), township: townships[ti++ % 5], jersey_size: jersey(), parent_phone: phone() });

for (const r of rows) T.applyCreateRecord("player", r.full_name, r, "demo");

// Demo a link group (two non-siblings who want to be on the same team).
if (!T.getFields("player").some((f) => f.name === "link_group")) T.addField("player", "link_group", "text", "Link group");
if (!T.getTeamRules().some((r) => r.field === "link_group")) T.createTeamRule("keep_together", "link_group", "Keep linked players together");
const all = T.getRecords("player");
const a = all[all.length - 1], b = all[all.length - 2];
T.updateRecord(a.id, { link_group: "Carpool A" });
T.updateRecord(b.id, { link_group: "Carpool A" });

// Report
const byLeague = {};
for (const r of T.getRecords("player")) { const lg = JSON.parse(r.data || "{}").league || "(none)"; byLeague[lg] = (byLeague[lg] || 0) + 1; }
console.log(`Added ${rows.length} demo players.`);
console.log("By league:", byLeague);
console.log(`Linked "Carpool A": ${b.name} + ${a.name}`);
console.log("Open the app and check Players, 🏆 Leagues, and 🧩 Team Builder.");
