# E.A.S.Y — Next.js version

A polished, local, private league manager. Same brain as the Python prototype (a flexible
`records / fields / rules` data model, assignment rules, a local AI you talk to, full
audit + undo) — rebuilt with a real React/Next.js front-end so it looks like an app.

Everything runs on your machine. Your data lives in one SQLite file (`league.db`). Nothing
leaves your computer.

---

## Setup (one time)

1. Install **Node.js 18+** — https://nodejs.org
2. Install **Ollama** — https://ollama.com — then pull a model:
   ```
   ollama pull qwen2.5:7b
   ```
3. From this folder, install the packages:
   ```
   npm install
   ```

## Run it

```
npm run dev
```

Then open **http://localhost:3000**. Make sure the Ollama app is running (it powers Build & Ask).

> First load creates `league.db` automatically. On the **Home** or **Leagues** page, click
> **“Set up standard Players”** to get a Players section with the five townships and two
> leagues — or just tell the assistant what to build.

To use a different model, set it when you start: `OLLAMA_MODEL=llama3.1:8b npm run dev`.

---

## What you can do

- **Build & Ask** — describe what you want; the assistant proposes changes, you **Confirm**
  or **Cancel**, and an **Undo** button reverses the last batch. (The AI only changes the
  backend — sections, fields, rules, data; it does not edit the app's code.)
- **Sections** (Players, Teams, …) — a tab each for **List**, **Add one**, and
  **Import CSV / Excel** (.csv/.xlsx/.xls) with a “which township is this from?” tag.
- **Leagues & Assignment** — manage townships and leagues, and set rules like
  *age ≥ 13 → Saturday Limerick*. Players are routed automatically on add/import.
- **Advanced** — schema, rules, and full change history with one-click undo.

## How it's organized

| Path | What it is |
|------|------------|
| `lib/db.js` | SQLite spine — schema-as-data, audit log, undo. |
| `lib/tools.js` | The backend toolbox (the only way data changes). |
| `lib/agent.js` | The Ollama tool-calling agent + propose/confirm plan. |
| `app/api/*` | API routes the UI calls. |
| `app/page.jsx` + `components/*` | The React UI. |

## Notes
- Back up `league.db` to keep your data safe — it's one file.
- The data engine is tested; the UI is best verified by running `npm run dev`.
