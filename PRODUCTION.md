# Production checklist

What to set, watch, and back up once the app is live.

## Environment variables

| Var | Required | Default | What it does |
|---|---|---|---|
| `NODE_ENV` | yes (for prod) | — | Set to `production`. Also flips session cookies to Secure. |
| `LEAGUE_DB` | yes (in container) | `./league.db` | Path to SQLite file. Set to `/data/league.db` for Render disk. |
| `ANTHROPIC_API_KEY` | one of these | — | Claude (best quality). Set `LLM_PRIMARY=claude`. |
| `GROQ_API_KEY` | one of these | — | Groq (free, fast). Set `LLM_PRIMARY=groq` if Claude isn't set. |
| `LLM_PRIMARY` | no | `auto` | `claude` / `groq` / `ollama` / `auto` — which provider to try first. |
| `CLAUDE_MODEL` | no | `claude-haiku-4-5` | Default model — cheap, good. Bump to Sonnet for hard tasks. |
| `GROQ_MODEL` | no | `llama-3.3-70b-versatile` | Reasoning model. |
| `GROQ_FAST_MODEL` | no | `llama-3.1-8b-instant` | Used after a plan is set, for faster dispatch. |
| `GEMINI_API_KEY` | no | — | Last-resort fallback. |
| `RATE_PER_MIN` | no | `60` | Per-IP request cap per minute. |
| `RATE_PER_HOUR` | no | `600` | Per-IP cap per hour. |
| `LLM_MAX_MESSAGES` | no | `20` | Conversation history truncation. |
| `LLM_MAX_CHARS_PER_MSG` | no | `6000` | Per-message truncation. |
| `LLM_MAX_TOKENS` | no | `2048` | Max response tokens. |

> **Auth note:** as of this version, per-user accounts replace the old
> `APP_SECRET` shared password. The first visitor to a fresh database creates
> the admin account on the login page; from then on every audit row is stamped
> with the signed-in user's display name. Existing `APP_SECRET` env vars are
> ignored.

## Backups

Render mounts the disk at `/data` and snapshots it daily — but only on paid plans. For free-tier safety, set up a weekly export:

1. Render → your service → **Jobs** → **+ Cron Job**
2. Schedule: `0 4 * * 0` (Sundays at 4am UTC)
3. Command:
   ```bash
   sqlite3 /data/league.db ".backup /data/backup-$(date +%F).db" && \
   ls /data/backup-*.db | sort | head -n -8 | xargs -r rm
   ```
   Keeps the last 8 weekly backups.

To pull a backup down:
1. Render → service → **Shell**
2. `cat /data/backup-2026-06-09.db | base64`
3. Decode that output on your laptop.

## Monitoring

The app exposes `/api/health` with everything you need to alarm on:

```json
{
  "ok": true,
  "llm": { "last_provider": "groq", "last_error": null, ... },
  "guard": { "auth_enforced": true, "rate_per_min": 60, ... },
  "uptime_sec": 12345
}
```

Free monitor options (any will work):
- **UptimeRobot** (free): hit `/api/health` every 5 min, alert if non-200
- **Render's built-in** (free): notifications on deploys + crashes
- **Better Stack / Sentry** (free tiers): for client-side JS errors

## Security checklist

- [x] `APP_SECRET` set and shared only via a password manager
- [x] HTTPS automatic on Render
- [x] Rate limits enabled
- [x] LLM context truncation prevents prompt-injection blowup
- [x] Code edits are approval-only (never auto-applied)
- [x] DB writes go through the existing audit log with Undo
- [ ] Set Groq rate limit in their dashboard as a hard safety net
- [ ] Rotate `APP_SECRET` if anyone leaves the team
- [ ] Periodically review `.ai-pending-changes/` and clean stale entries

## Cost watching

- Groq is free at your scale — but check the Groq dashboard monthly anyway.
- Render free tier shows monthly bandwidth at the bottom of the service page.
- If you upgrade to Render Starter ($7/mo) for always-on, set a billing alert in your Render account.

## Scaling triggers (when to upgrade what)

| Symptom | Fix |
|---|---|
| Cold starts feel slow | Render Starter ($7/mo) |
| `429 Too many requests` for legitimate users | Bump `RATE_PER_MIN` |
| AI feels constrained | Switch `GROQ_MODEL` to `llama-3.3-70b-versatile` for speed, or add `ANTHROPIC_API_KEY` and route to real Claude |
| More than 10 teammates | Add real auth (NextAuth) instead of shared password |
| Multiple leagues | Add `org_id` to records, scope queries by org |
| SQLite write contention | Migrate to Postgres (Neon, Supabase, Render Postgres) |

## Logs

Render → service → **Logs** is searchable. Useful filters:
- `[api/agent]` — agent errors
- `[llm]` — provider failures and fallback events
- `429` — rate limit hits
- `401` — unauthorized attempts

## Disaster recovery

If the deploy is broken:
1. Render → **Deploys** → pick a previous green deploy → **Redeploy**
2. The disk and DB are not touched, only the code reverts.

If the DB is corrupted:
1. Render → **Shell**
2. `cp /data/backup-<latest>.db /data/league.db`
3. Restart the service.

## What's NOT production-grade yet (and what to add when you need it)

- **Per-user accounts.** Currently one shared password — fine for 3 trusted teammates, not for the public. Swap in NextAuth + email login when you need it.
- **Multi-tenancy.** All records share one league context. To run multiple leagues in one app, add `org_id` columns and scope every query.
- **Audit log redaction.** PII (player names, parent contacts) sits unredacted in the audit log. If you ever store sensitive data, add a redaction step before logging.
- **Background scheduler.** Right now the AI only does things when you ask. To add "warn me each Sunday if anyone's missing jersey size," add a Render Cron Job that POSTs to `/api/agent` with a stock prompt.
