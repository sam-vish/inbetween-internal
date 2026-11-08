# Inbetween — notes for Claude Code

Real-time AI clipping for YouTube Live (PRD: `docs/PRD.md`). TypeScript monorepo, pnpm workspaces, Node 22.
Internal packages ship TS source (no build step); apps run with `tsx`.

## Layout
```
apps/worker      ingest → signals → scorer → clipper → fast-lane render; operator actions; delivery
apps/dashboard   Next.js 16 operator UI (Supabase auth + Realtime). Next 16: middleware is `proxy.ts`; params/cookies are async.
apps/premium     post-stream premium edits (Claude Code headless + HyperFrames) and weekly compilations
packages/shared  types, client config schema (zod), env, Db (Supabase|memory), storage (R2|local), cost + quota ledgers
packages/adapters/youtube   the ONLY YouTube-specific code (probe, Data API, streamList gRPC, OAuth, recorded chat)
packages/adapters/registry  `@inbetween/adapters` — the only importer of concrete adapters
packages/signals  EWMA baselines, chat/audio/voice signals, MomentScorer
packages/providers  ASR (Groq/Deepgram/Sarvam), vision (Gemini), LLM (Claude) + mocks
packages/render   ffmpeg builders, vertical layouts, ASS captions
packages/delivery Discord / Telegram / Drive / local
supabase/         migrations (schema, RLS, RPCs, Realtime) + seed
scripts/          make-synthetic, replay (VOD + chat log), e2e
infra/            Dockerfiles + docker-compose
```

## Rules (from the PRD)
- All YouTube code stays in `packages/adapters/youtube`; apps import `@inbetween/adapters` only.
- Every signal, provider and render step sits behind an interface; the scorer never imports providers/platforms.
- Count every YouTube API call: call `QuotaLedger.spend()` BEFORE the request. A quota bug is an outage.
  Never poll the Data API for go-live (use the `/live` page probe). Prefer `streamList` for chat.
- Log every second to `signal_samples` (scorer training data).
- Viewer privacy: hash chat authors (`hashAuthor`), never store raw viewer channel IDs. Retain chat/signals 30 days.
- Only ingest channels with consent on file. Nothing from non-client streams is ever published.
- Secrets only in `.env`; keep commands non-interactive.
- Re-check current YouTube/Google/Anthropic docs before changing API usage (verified 2026-11-08: streamList is
  gRPC at youtube.googleapis.com:443, 5 units/connection, accepts API key or OAuth token).

## Commands
```bash
pnpm install
pnpm test                 # vitest: unit + ffmpeg integration (needs ffmpeg/ffprobe, Noto fonts)
pnpm typecheck            # root tsc + dashboard tsc
pnpm e2e                  # offline end-to-end on a synthetic stream (~2–3 min)
pnpm replay --video vod.mp4 --chat vod.live_chat.json --memory   # tune on a recorded VOD
pnpm worker               # live worker (reads .env)
pnpm dashboard            # Next dev server on :3000
```

## Conventions
- Timestamps are epoch ms in code, `timestamptz` in Postgres; signal seconds are epoch seconds.
- Client config is always parsed through `ClientConfigSchema` (zod 4: nested objects use `.prefault({})`).
- Stream clock (`Clock`) is injected everywhere so replay can run faster than real time.
- Claude calls: `claude-opus-5-5`, structured outputs via `betaZodOutputFormat`, `fallbacks: 'default'`.
