"use client";
import HubCards from "./HubCards.jsx";
import { currentSeason } from "@/lib/api.js";

// How the season is going — results, standings, the extras. Everything here
// reads the season in the sidebar picker.
const ITEMS = [
  {
    view: { page: "standings" },
    title: "Standings & Scores",
    blurb: "Enter results and see the table — W-L-T, points for and against. Scores drive the standings; nothing is typed twice.",
  },
  {
    view: { page: "tournaments" },
    title: "Tournaments",
    blurb: "One-off brackets and pool play, separate from the round-robin season.",
  },
  {
    view: { page: "rankings" },
    title: "Player Rankings",
    blurb: "End-of-season ranks per player, kept per season so a kid's history builds up year over year.",
  },
  {
    view: { page: "raffle" },
    title: "Raffle",
    blurb: "Draw a winner from the roster.",
  },
];

export default function SeasonPage({ go }) {
  const s = currentSeason();
  return (
    <HubCards
      title="Season"
      blurb={`How ${s === "*" ? "the season" : s} is going — results, standings and the extras.`}
      items={ITEMS}
      go={go}
    />
  );
}
