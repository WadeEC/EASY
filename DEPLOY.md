# Deploy — zero to live URL in ~15 minutes

End state: a URL like `https://flag-football.onrender.com` your team opens from
any device (phone, tablet, laptop) and signs in with their own account. Sessions
last 30 days. All writes are stamped with the signed-in user's name in the
Change log.

The same instructions work on **Render**, **Fly.io**, **Railway**, or any
Docker host. Render is the cheapest path to "live" because the free tier
includes a 1 GB persistent disk and a free HTTPS subdomain.

---

## Step 1 — Push the code to GitHub (5 min)

```bash
cd flag-football-node
git init
git add -A
git commit -m "initial commit"
gh repo create flag-football --private --source=. --push
```

(Without the `gh` CLI: create an empty private repo at https://github.com/new
and follow the `git remote add` + `git push` commands GitHub shows you.)

## Step 2 — Get an AI key (2 min)

Pick **one**:

- **Claude (recommended, best quality)** — go to https://console.anthropic.com,
  create an API key, paste it later as `ANTHROPIC_API_KEY`. Pay-as-you-go;
  Haiku costs pennies per day at typical use.
- **Groq (free)** — https://console.groq.com → create key, paste later as
  `GROQ_API_KEY`. Set `LLM_PRIMARY=groq`. 14,400 requests/day free.

You can set both — the app falls through automatically.

## Step 3 — Deploy on Render (5 min)

1. https://dashboard.render.com (sign in with GitHub).
2. **New +** → **Blueprint** → pick the repo.
3. Render reads `render.yaml`, shows the plan, click **Apply**.
4. While it builds, open **Environment** and paste the key from Step 2
   (`ANTHROPIC_API_KEY` or `GROQ_API_KEY`).
5. First build takes ~5 minutes. The disk persists across deploys.

Render shows the live URL on the service page, e.g.
`https://flag-football-xyz.onrender.com`. Free tier sleeps after 15 minutes of
inactivity (~30 s cold start). Upgrade to **Starter ($7/mo)** for always-on.

## Step 4 — Create your account (1 min)

Open the live URL. The login page detects the empty database and lands on
**Create account** mode automatically.

1. Display name (what shows on the Change log).
2. Username (lowercase letters, numbers, dot/dash/underscore).
3. Password (6+ chars; use a password manager).
4. **Create account**.

You're signed in. Anyone hitting the URL after this gets the **Sign in** form
by default. You can add more accounts from the admin Users endpoint
(`POST /api/auth/users`) — a Users page UI is on the roadmap.

## Step 5 — Share the URL

Send the URL to your team. On mobile they can **Share → Add to Home Screen**
and it installs like a native app. Each person creates their own account on
first visit (or you can pre-create accounts for them).

---

## What you just got

- Live URL with HTTPS, accessible from any device.
- Per-user accounts (PBKDF2-hashed passwords, 30-day sessions).
- Every audit / change log entry stamped with the signed-in user.
- AI (Claude or Groq) wired up.
- Persistent SQLite database on a 1 GB Render disk.
- Per-IP rate limits (60/min, 600/hr).
- `/api/health` for uptime monitors.
- Auto-deploy on every `git push` to main.

Total ongoing cost: **~$0** (Render free + Groq free), or a few dollars/month
if you use Claude + Render Starter for always-on.

## Custom domain (optional)

Render → **Settings** → **Custom Domains** → point a domain you own
(`flag.yourleague.com`) at the service. Free TLS cert is automatic.

## Going further

- **Postgres** instead of SQLite if you outgrow it: swap `lib/db.js` to `pg`,
  point at Neon / Supabase / Render Postgres.
- **Background jobs** (nightly digests, "warn me if X" alerts) — add Render's
  Cron Job service to POST to `/api/agent` on a schedule.
- **Multi-tenancy** — add `org_id` to records and scope every query.

See `PRODUCTION.md` for backups, monitoring, scaling triggers, and disaster
recovery.

---

## Troubleshooting

**"No LLM available"** — `ANTHROPIC_API_KEY` or `GROQ_API_KEY` missing. Check
the Render Environment tab. The provider chip in the assistant should read
**Online · Claude** (or Groq) when it's working.

**Can't sign in after a deploy** — the session cookie is HTTPS-only in prod.
Make sure you're using `https://` not `http://`.

**Database "lost" after a redeploy** — disk wasn't mounted. Check Render's
**Disks** tab; should show `league-data` mounted at `/data`. `LEAGUE_DB` env
should be `/data/league.db`.

**Locked yourself out** — Render → **Shell** → run:
```bash
sqlite3 /data/league.db "DELETE FROM users WHERE username='myname';"
sqlite3 /data/league.db "DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users);"
```
Then visit the login page and create a new account.
