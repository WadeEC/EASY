"use client";
import { useEffect, useState } from "react";
import TeamBuilder from "./TeamBuilder.jsx";
import TeamEditor from "./TeamEditor.jsx";

// The Teams page: a toggle between building teams and editing the saved teams.
export default function TeamsPage({ go, onAsk, tab }) {
  const [sel, setSel] = useState(tab === "build" ? "build" : "editor");
  // Keep the toggle in sync if something navigates here with a tab (e.g. the "Build teams" link).
  useEffect(() => { if (tab) setSel(tab === "build" ? "build" : "editor"); }, [tab]);

  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className={"pill" + (sel === "editor" ? " active" : "")} onClick={() => setSel("editor")}>Team Editor</button>
        <button className={"pill" + (sel === "build" ? " active" : "")} onClick={() => setSel("build")}>Build teams</button>
      </div>
      {sel === "build" ? <TeamBuilder go={go} onAsk={onAsk} /> : <TeamEditor go={go} onAsk={onAsk} />}
    </div>
  );
}
