# Set up Groq + Gemini (both free, ~5 minutes)

You'll have GPT-level smart AI running in under 5 minutes. Both keys are free, no credit card.

## Step 1 — Get Groq key (primary, 2 min)

1. Go to https://console.groq.com
2. Sign in with Google
3. Left sidebar → **API Keys**
4. **Create API Key** → name it `flag-football` → Submit
5. **Copy the key now** — starts with `gsk_…`, shown only once

## Step 2 — Get Gemini key (backup, 2 min)

1. Go to https://aistudio.google.com
2. Sign in with Google
3. Top right → **Get API Key**
4. **Create API key in new project**
5. **Copy the key**

## Step 3 — Put both into the app (1 min)

In Finder, open the `flag-football-node` folder. You'll see a file called `.env.local.example`.

1. Duplicate it (Cmd+D)
2. Rename the copy to **`.env.local`** (delete the `.example` part)
3. Open it in TextEdit (right-click → Open With → TextEdit)
4. Paste your two keys in:

```
GROQ_API_KEY=gsk_your_actual_groq_key
GEMINI_API_KEY=your_actual_gemini_key
LLM_PRIMARY=groq
```

5. Save (Cmd+S) and close

## Step 4 — Restart the app

In the Terminal window running the app: press **Ctrl + C** to stop it. Then double-click **`Start App.command`** again.

## Step 5 — Verify it works

Open the app in your browser. Click the **AI** bubble in the corner. Look at the header:

- 🟢 Green **"Online · Groq"** badge = working
- 🟣 Purple **"Offline · Local"** badge = something's wrong; check `.env.local`

Ask it "how many players are in both leagues" — it should answer with actual numbers instantly.

You can also visit `http://localhost:3000/api/health` to see provider status as JSON.

## What you now have

- **Primary:** Groq DeepSeek R1 — Claude-level reasoning, sub-second
- **Backup:** Gemini 2.0 Flash — kicks in if Groq is rate-limited or down
- **Fallback:** Ollama (if you ever run it) for offline
- **Cost:** $0/month, indefinitely

## Troubleshooting

**Badge stays purple after restart.** The `.env.local` file isn't being read. Make sure:
- It's in the `flag-football-node` folder (not next to the `Start App.command`)
- It's named exactly `.env.local` (with the dot, no `.txt` extension)
- macOS may have hidden the dotfile — in Finder, press **Cmd+Shift+.** to show hidden files

**"401 Unauthorized" in browser console.** Your Groq key has a typo. Double-check it starts with `gsk_` and has no spaces.

**"Quota exceeded" rare error.** Either Groq daily limit hit (you won't at 3 users) or Gemini per-minute limit. The app auto-falls-back between them, so just retry.
