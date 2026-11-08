# Runbook

## Supabase project

| | |
|---|---|
| Project | `inbetween-live` (ref `sdiypdkvksqwwxijvdaz`), org "sam-vish's Org", region ap-south-1 (Mumbai), free plan |
| API URL | `https://sdiypdkvksqwwxijvdaz.supabase.co` |
| Publishable key | `sb_publishable_ZY0b9ND9h1hOpgKVdDauMg_B6VJpQR8` (browser-safe) |
| Migrations applied | `20261108125350_init`, `20261108130332_harden` (security advisors clean except the intentional deny-all on `signal_samples_*` partitions) |
| Operators | `public.operators` — add a row per operator email (role `admin` or `operator`) |

Still to do in the Supabase dashboard:
1. **Secret key** → Project Settings → API Keys → Secret keys → copy into `SUPABASE_SERVICE_KEY` (worker + dashboard server only).
2. **Auth → URL Configuration**: Site URL = the dashboard URL; add `<dashboard>/auth/callback` to Redirect URLs
   (`http://localhost:3000/auth/callback` for local dev).
3. **R2 lifecycle**: 30-day expiry on `sources/` (PRD §6), in Cloudflare.
4. The free plan pauses projects after a week of inactivity; upgrade to Pro before clients rely on it.

## Preflight

`pnpm preflight` checks binaries, fonts, Supabase, Redis, R2, YouTube (page probe + 1-unit API check), OAuth config,
ASR/vision/Claude keys, Telegram/Drive/ops alerts, and prints a fix for each failure. `--no-quota` skips the YouTube call.

## Milestone checks (PRD §7)

The code for M1–M3 and the M4 plumbing is in place; each milestone's "done when" still has to be shown on real
streams. Do not move on until it passes.

| Milestone | How to verify |
|---|---|
| **M1: Pipe works** | Onboard a consenting GTA RP creator (or simulcast). During a live stream: `curl localhost:8787/metrics` → `streams.<id>.quotaUnits` must stay < 300 for 4 h; first raw clip on the board/Discord within 90 s of a chat spike (`clip_latency`); no crash for 4 h (`uptime_s`, `ingest.drops`, buffer `gaps`). |
| **M2: Real clips** | Fast-lane `clip_latency.p50_ms` ≤ 120 000 on 3 test streams; ≥ 40% of proposed moments judged clip-worthy (stream summary → approval rate); Hinglish captions readable. Run the ASR bake-off: same replay with `ASR_PROVIDER=groq|deepgram|sarvam`. |
| **M3: Operable** | Operator approves a clip in < 30 s (keyboard: J/K, 1/2/3, A); 3 streams at once for 6 h (`MAX_STREAMS`, CPU/memory on `/metrics`). |
| **M4: GTA-aware** | Label launch-week frames, fill `packages/providers/game_profiles/gta6.json` (`reference_images`, `hud_notes`), set clients' `vision.game_profile=gta6`; re-fit weights from `signal_samples` + approve/reject; premium edits reviewed and delivered. |

Ingest acceptance (PRD 4.2): 8 h on one stream with < 10% memory growth (`memory_mb.rss`) and < 1% segment loss
(`buffer.gaps` vs `ingest.segments`).

## Onboarding a client
1. Dashboard → **Clients → Add**: name, channel ID (`UC…`), layout, caption language, delivery target.
2. Client page → **Create consent link** → send it. The client signs in with Google (read-only YouTube scope). The
   callback checks the authorized channel matches, stores the encrypted refresh token and `consent_at`. Keep the
   short written agreement on file as well (PRD §6).
3. Ask the creator to use **Low latency** in YouTube Studio for faster clips.
4. When they are live, set the facecam rectangle on the live frame (drag on it) and check the 9:16 preview.
5. Telegram delivery: add the bot to the client's group, use the chat ID (e.g. `-100…`). Drive: share the folder
   with the service account email, use the folder ID.

## Launch night (Nov 19)
- Before: `GET /healthz` on every worker; quota page < 10%; R2/Redis/Supabase reachable; a replay run passes.
- Watch `/metrics`: `queues.render.waiting` should stay near 0. If it grows, start a second worker box
  (`WORKER_HOST_ID` must differ; each box renders its own streams) — keep the VPS image ready.
- Quota alerts arrive on the ops Discord/Telegram at 70% / 90% / 100%. At 90% new streams start without API chat.
- Cost cap alert per stream: vision degrades to sparse-only automatically.

## YouTube quota
- Go-live checks never use the Data API (page probe). `videos.list` (1 unit) only confirms a candidate.
- Chat: one `streamList` connection per stream (5 units), resumed with the last page token on drops. Polling
  fallback costs 5 units per poll (`CHAT_POLL_MIN_MS` floor) — avoid it at scale.
- Apply for a quota increase before ~10 concurrent clients.

## YouTube bot wall
Datacenter IPs can get "Sign in to confirm you're not a bot" from streamlink/yt-dlp. Export cookies from a dedicated
logged-in account (Netscape format) and set `YOUTUBE_COOKIES_FILE`. The page probe also sends them.

## Data retention (PRD §6)
`ib_maintenance()` runs daily from the worker janitor: drops `signal_samples` partitions > 30 days, deletes
`chat_events` > 30 days. Rolling segments are deleted after 5 minutes; local source clips after 30 days (R2: set a
30-day lifecycle rule on the `sources/` prefix). Replay data of non-client streams: delete `DATA_DIR` after tuning.

## Premium lane
Runs on a machine with the `claude` CLI, HyperFrames (`npx hyperframes doctor`) and the skills in
`apps/premium/.claude/skills/`. `pnpm premium:worker` consumes the queue; `pnpm --filter @inbetween/premium run-job
<momentId> --brief-only` prepares a job without rendering. Every premium edit and compilation needs operator approval
before delivery. Weekly compilations: `pnpm --filter @inbetween/premium compile --all --days 7` (cron weekly).

## Auto-posting Shorts (not in v1)
`videos.insert` has its own small quota bucket, and uploads from unverified API projects stay private until Google's
API compliance audit passes. Start the audit early if auto-posting is on the roadmap.
