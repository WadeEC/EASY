"use client";
import HubCards from "./HubCards.jsx";

// The Saturday-morning pages — what's open on the laptop at the table.
// All three write the same check-in records, so a player scanned at the gate
// is already ticked on the other two.
const ITEMS = [
  {
    view: { page: "board" },
    title: "Team Board",
    blurb: "The big screen at the table — who's arrived, per team, with alerts for anyone missing a jersey size. Type a name to check someone in.",
  },
  {
    view: { page: "scanin" },
    title: "Kiosk",
    blurb: "Scan a key tag or type a name to check a player in, and confirm their jersey size before printing.",
  },
  {
    view: { page: "attendance" },
    title: "Attendance",
    blurb: "This week as a sheet you fill in and save — present, absent, excused — plus the season grid. Export any week to Excel or CSV.",
  },
];

export default function StationsPage({ go }) {
  return (
    <HubCards
      title="Stations"
      blurb="What's open on the laptop at the table. All three share the same check-ins."
      items={ITEMS}
      go={go}
    />
  );
}
