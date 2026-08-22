"use client";
import HubCards from "./HubCards.jsx";

// The things you touch rarely and need to be sure about when you do.
const ITEMS = [
  {
    view: { page: "master" },
    title: "Master Spreadsheet",
    blurb: "Every row ever imported into this season, exactly as it arrived — including columns the app doesn't otherwise track. The source of truth when a roster looks wrong.",
  },
  {
    view: { page: "users" },
    title: "Users",
    blurb: "Who can sign in, and who's an admin. Disable an account without losing what it did.",
  },
  {
    view: { page: "changelog" },
    title: "Change log",
    blurb: "Every change, who made it, and what it was before. Undo any single one.",
  },
  {
    view: { page: "timemachine" },
    title: "Time Machine",
    blurb: "Rewind the whole system to a moment in time. Data only — sections, fields and rules are left alone so nothing breaks.",
  },
  {
    view: { page: "advanced" },
    title: "Advanced",
    blurb: "Sections and fields, AI provider and cost, and the rest of the machinery. Fine to ignore day to day.",
  },
];

export default function SettingsPage({ go }) {
  return <HubCards title="Settings" blurb="The parts you don't need on a Saturday." items={ITEMS} go={go} />;
}
