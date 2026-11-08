# Inbetween

Real-time AI clipping for YouTube Live streamers. Inbetween watches a client's live stream, detects the moments chat
loses it, cuts them from a rolling buffer and has a captioned vertical Short ready for operator review in about two
minutes. Spec: [`docs/PRD.md`](docs/PRD.md) · ops guide: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

```
YouTube Live ─► worker: go-live probe (no quota) ─► streamlink → ffmpeg: 2s segments · 16k PCM · 480p frames
                        streamList chat (gRPC, 5 units/conn)
             ─► signals: chat_rate · chat_reaction · chat_caps · audio_loud · voice_hype (ASR) · vision_event (Gemini)
                 EWMA z-scores per channel ─► Redis Streams ─► scorer (2+ families, paid suppression, cooldown, chat-lag fix)
             ─► clipper: padded source clip ─► fast lane: caption ASR → Hinglish/Devanagari fix → Claude titles → ASS → one ffmpeg pass
             ─► R2 + Supabase ─► dashboard (Realtime) ─► approve → Discord / Telegram / Drive
                                                     └► premium lane (Claude Code + HyperFrames) · weekly compilation
```

## Quick start (offline, no keys)

```bash
pnpm install
pnpm test        # 70+ tests incl. real ffmpeg renders and a fake gRPC streamList server
pnpm e2e         # synthetic stream → moments → 1080×1920 clips → approve → delivery
```

`pnpm e2e` generates a 4-minute synthetic stream with two real moments and a Super Chat TTS decoy, runs the whole
pipeline at 2× speed with mock ASR/LLM, and asserts both moments are found (±3s), the decoy is suppressed, and the
clips are rendered and delivered. Outputs land in `data/e2e/`.

## Running for real

1. **Supabase**: the `inbetween-live` project is created and migrated (details in `docs/RUNBOOK.md`). Copy its secret
   key into `SUPABASE_SERVICE_KEY` and set the Auth redirect URL. For a fresh project: `supabase db push`, then add
   operator emails to `public.operators`.
2. **Keys**: copy `.env.example` → `.env`. Minimum for live clipping: `YOUTUBE_API_KEY`, Supabase, Redis, R2,
   one ASR key (`GROQ_API_KEY`), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and the OAuth/secret values.
3. **Check**: `pnpm preflight` lists every missing key/binary/service with the fix.
4. **Run**: `docker compose -f infra/docker-compose.yml --env-file .env up -d --build` (Redis + worker + dashboard),
   or `pnpm worker` and `pnpm dashboard` directly (needs `ffmpeg`, `streamlink`, `yt-dlp`, Noto fonts).
5. **Onboard a client** in the dashboard (Clients → Add), send them the consent link, set the facecam crop on a live
   frame. Ingest starts automatically when they go live.

Tune on recorded streams without waiting for one:

```bash
yt-dlp --write-subs --sub-langs live_chat --skip-download -o vod "https://www.youtube.com/watch?v=<id>"   # chat
yt-dlp -f "best[height<=720]" -o vod.mp4 "https://www.youtube.com/watch?v=<id>"                           # video
pnpm replay --video vod.mp4 --chat vod.live_chat.json --client client-config.json --speed 2 --memory
```

Replays of non-client streams are for internal tuning only: nothing from them is published, and their data dir should
be deleted after the session (PRD §6).

## Repo

| Path | What |
|---|---|
| `apps/worker` | supervisor, ingest, rolling buffer, signal producers, scorer runner, clipper, fast lane, actions, delivery |
| `apps/dashboard` | Next.js 16 operator UI: live board, settings + facecam tester, stream summary, costs & quota, OAuth links |
| `apps/premium` | premium edits (headless Claude Code + HyperFrames), weekly compilations |
| `packages/*` | shared types/config/db/storage/quota/cost, YouTube adapter + registry, signals + scorer, providers, render, delivery |
| `supabase/` | schema, RLS, RPCs, Realtime publication |
| `scripts/` | synthetic stream generator, replay, e2e |
| `infra/` | Dockerfiles, docker-compose |
