# AI Assistant — extended integration

The flag-football app's AssistantWidget is now a full agent: it can think, warn, suggest, remember, restyle the UI live, edit data, and propose code changes — all on free models.

## What's new (vs. the original Ollama-only agent)

| Capability | How |
|---|---|
| Cloud fallback when Ollama is down | `lib/llm.js` routes Ollama → Groq (DeepSeek R1) → Gemini Flash |
| Live UI manipulation (CSS, theme, layout, dark mode, density, fonts) | 27 `ui_*` tools in `lib/ui-tools.js`, applied by `lib/ui-applier.js` |
| Page awareness ("this button", "that table") | Widget sends a DOM snapshot + recent activity with every message |
| Long-term memory (preferences, league settings) | SQLite FTS5 in `lib/memory.js`; `remember` / `recall` tools |
| Multi-step plans, warnings, suggestions, clarifications | Meta tools in `lib/meta-tools.js` |
| Code-edit proposals with diff + approve/reject | `lib/code-tools.js` + `app/api/code-approvals/route.js` |
| Persisted theme (survives reload) | `localStorage` keys `easy_theme_vars`, `easy_dark`, etc. |

## Setup

The integration is plug-and-play — no env changes required if you keep using Ollama. To enable cloud fallback:

```bash
# .env.local (optional)
GROQ_API_KEY=...           # https://console.groq.com — free
GEMINI_API_KEY=...         # https://aistudio.google.com — free
GROQ_MODEL=deepseek-r1-distill-llama-70b   # default; override if you want
```

Then:

```bash
npm install   # picks up optional groq-sdk + @google/generative-ai
npm run dev
```

## What the AI can now do

**Visible/live changes (apply immediately, no rebuild):**
- "Make the header dark blue"
- "Hide the schedule tab for now"
- "Switch to dark mode and remember that I like it"
- "Make everything more compact"
- "Use a serif font"
- "Save this look as 'gameday'"

**Backend data changes (existing flow, plan + Undo):**
- "Add a jersey size field"
- "Set up coaches and standard divisions"
- "Build a schedule for Saturday Limerick"

**Code changes (queued for approval with diff):**
- "Add a 'Print roster' button to the Teams page"
- "Rename the StudentList component to RosterList"

**Knowledge/help:**
- "Why isn't this player on a team?" — answers from data
- "What does the all-star cap do?" — explains
- "Suggest things I should set up next" — gives prioritized tips

## File map

```
lib/
  agent.js              # the loop — now uses llm.js + extended tools
  llm.js                # NEW — Ollama → Groq → Gemini fallback
  ui-tools.js           # NEW — 27 UI tools
  ui-applier.js         # NEW — client-side DOM applier (injected by widget)
  meta-tools.js         # NEW — plan/warn/suggest/clarify/remember/recall/finish
  memory.js             # NEW — SQLite FTS5 facts table
  code-tools.js         # NEW — read/propose-edit/propose-new with diff queue
  tools.js              # unchanged — league/schema/data tools
components/
  AssistantWidget.jsx   # rewritten — handles new outputs + injects applier
app/api/
  agent/route.js        # accepts pageContext
  code-approvals/       # NEW — list/approve/reject code edits
  memory/               # NEW — list/forget facts
```

## Safety

- Code edits never auto-apply. They write to `.ai-pending-changes/` and require an Approve click.
- Backend data changes still go through `applyPlan` with the existing audit log and Undo.
- The model is told to call `warn_user` before destructive operations and STOP until the user confirms.

## Cost

$0/month at 3-user scale.
- Ollama: free, local, private — handles ~80% of calls.
- Groq free tier: 14,400 req/day — covers the rest if Ollama hiccups.
- Gemini: 1,500 req/day — backup of last resort.

## Extending

Add a tool: drop a new entry in the matching `*-tools.js` file with a name, JSON schema, and handler. The agent picks it up on next request — no other changes needed.

Add a UI op: add it to `ui-tools.js` (server side) AND its `apply()` case in `ui-applier.js` (client side).
