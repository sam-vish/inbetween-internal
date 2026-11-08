# Inbetween: System PRD (Internal) — YouTube Live edition

> Real-time AI clipping for YouTube Live streamers. It watches a live stream, detects the moments chat loses it, cuts them from a rolling buffer, and has vertical Shorts ready within about 2 minutes.

- **Owner:** Sameer (BrainChain Labs)
- **Status:** v1 build, internal tool for the agency phase
- **Platform:** **YouTube Live only** for v1. Twitch and Kick come later as ingest adapters.
- **Launch target:** live and running for clients on **Nov 19, 2026** (GTA 6 launch day)
- **Users:** Sameer + Om (operators). Clients never log in during this phase.

---

## 1. Context

GTA 6 launches Nov 19, 2026 on PS5 and Xbox Series X|S, with no PC version at launch. Streamers will be live for 6 to 10 hours a day through the launch window. Their best 30 seconds die inside the VOD, and editors only get to them the next day.

**Why YouTube Live first:**
- Indian gaming and GTA RP creators (our first market, and where our network is) stream mainly on YouTube Live.
- Shorts live on the same platform, so a clip from the stream feeds straight back into the creator's own channel.
- Twitch has allowed simulcasting since Oct 2023, so many Twitch streamers can also be live on YouTube. Don't assume they are, though. Check each target.

Inbetween is the engine behind a done-for-you clipping agency:

1. Clients authorize their YouTube channel.
2. Inbetween watches their live stream and proposes moments.
3. Operators approve the good ones in a dashboard.
4. Clips are delivered to the client to post.

Everything works on the **video and chat stream**. Nothing ever touches the game.

### Goals (v1)
1. Detect high-value moments on a YouTube Live stream in real time.
2. Produce a ready-to-post vertical Short within **120s (p50)** of the moment.
3. Let operators review, tweak and approve clips fast, in under 30s per clip.
4. Run **3 to 10 client streams at once** on one server, reliably, for hours.
5. Stay inside YouTube API quota, and track the cost per stream-hour from day one.

### Non-goals (v1)
- Twitch and Kick ingest (the architecture must not block them; see 3.1)
- Self-serve signup, client auth beyond YouTube OAuth consent, billing, or multi-tenant SaaS
- Auto-posting Shorts to the creator's channel (see 4.8; needs a Google API audit)
- A mobile app
- Any interaction with the game itself

---

## 2. Users and core flows

### Operator (Sameer / Om)
1. Adds a client: YouTube channel ID, facecam position, caption language, layout preset. Sends the client an OAuth link to grant read-only access.
2. Client goes live, and ingest starts automatically.
3. Moments appear in the live feed on the dashboard with a preview, score and reason.
4. Operator approves, rejects, trims (±5s), or edits the title.
5. An approved clip renders in the fast lane, and the final MP4 goes to the client's delivery channel (Discord, Telegram or a Drive folder).
6. After the stream, the top N moments are queued for the premium lane (motion graphics edit).

### Client (creator)
- Clicks one Google OAuth link once (read-only YouTube scope). That's also the written consent record.
- Never touches the system after that. They get Shorts in their delivery channel, plus an end-of-stream summary.

---

## 3. System architecture

```
                   ┌───────────────────────────────────────────────┐
 YouTube Live ───► │ INGEST WORKER (per live broadcast)             │
  (HLS + chat)     │  - go-live detector (no-quota check + API)     │
                   │  - streamlink → ffmpeg → 2s .ts segments       │
                   │  - rolling buffer on disk (last 5 min)         │
                   │  - chat: liveChatMessages.streamList           │
                   └───────┬────────────────────────┬──────────────┘
                           │ segments               │ chat + Super Chat events
                           ▼                        ▼
                   ┌───────────────────────────────────────────────┐
                   │ SIGNAL WORKERS                                 │
                   │  chat │ audio │ voice (ASR) │ vision (HUD)     │
                   │  → per-second signal values → Redis streams    │
                   └───────────────────────┬───────────────────────┘
                                           ▼
                   ┌───────────────────────────────────────────────┐
                   │ SCORER                                         │
                   │  baseline-normalized fusion → moment events    │
                   └───────────────────────┬───────────────────────┘
                                           ▼
                   ┌───────────────────────────────────────────────┐
                   │ CLIPPER + FAST-LANE RENDER                     │
                   │  concat → cut → vertical → captions → R2 → DB  │
                   └───────────────────────┬───────────────────────┘
                                           ▼
        Dashboard (Next.js) ◄── Supabase (Postgres + Realtime) ──► Delivery (Discord / Telegram / Drive)
                                           │
                                           ▼
                   PREMIUM LANE (post-stream, HyperFrames + Claude)
```

### 3.1 Platform adapter (keep Twitch pluggable)
All platform-specific code lives behind one interface, so Twitch or Kick is a new adapter later, not a rewrite:

```ts
interface PlatformAdapter {
  detectLive(channel): Promise<LiveSession | null>
  openVideo(session): HlsSource            // streamlink target
  openChat(session): AsyncIterable<ChatEvent>  // normalized: text, author, ts, isPaid, amount
}
```
v1 ships `adapters/youtube` only. The scorer, render and dashboard never import platform code.

### Hosting
- **Workers run on a VPS or container host** (Hetzner, Fly.io or Railway). They are long-running processes holding stream connections and running FFmpeg, so they can't run on serverless or Vercel.
- **Dashboard:** Next.js. It can run on the same box or on Vercel, talking to Supabase.
- **Start sizing:** one 8-vCPU / 16GB box should handle about 5 concurrent streams with the fast lane. Measure this in M1 and scale horizontally per stream.
- **Region:** host close to the creators (for India, Mumbai or Singapore) to cut ingest lag.

### Stack
| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (Node 20+) | Monorepo with pnpm workspaces |
| Ingest | `streamlink` + `ffmpeg` (child processes) | YouTube Live HLS to 2s MPEG-TS segments |
| Chat | YouTube `liveChatMessages.streamList` (server-streaming) | 5 quota units per connection. Falls back to `list` polling. |
| Go-live | No-quota check of the channel's live page + `videos.list` | See 4.2 |
| Queue / bus | Redis + BullMQ, Redis Streams for signals | |
| DB / realtime | Supabase (Postgres + Realtime) | Dashboard live feed |
| Object storage | Cloudflare R2 (S3-compatible) | Clips, thumbnails |
| ASR | Pluggable. Test Groq Whisper, Deepgram and an Indic-focused ASR (e.g. Sarvam) in M2 | Word timestamps required. Must handle Hindi and Hinglish. |
| Vision | Gemini Flash (API); pluggable | Low-res frames, JSON output |
| Titles / labels | Claude (API) | Hook titles, moment labels, Hinglish transliteration |
| Premium edits | HyperFrames + Claude Code | Reuse the existing Inbetween edit/review code |
| Delivery | Discord webhook, Telegram bot, or a Google Drive folder per client | Indian creator teams often live on Telegram/WhatsApp |

### Repo structure
```
inbetween/
  apps/
    worker/        # ingest, signals, scorer, clipper
    dashboard/     # Next.js operator UI
    premium/       # HyperFrames project + scripts for premium edits
  packages/
    adapters/
      youtube/     # detectLive, openVideo, openChat (v1)
    shared/        # types, config schema, db client, cost + quota logger
    signals/       # chat/audio/voice/vision signal implementations
    render/        # ffmpeg command builders, caption (ASS) generator
    delivery/      # discord, telegram, drive
  infra/
    docker-compose.yml   # redis, worker, dashboard (local + VPS)
  CLAUDE.md
```

---

## 4. Functional requirements

### 4.1 Client config
Each client record holds:
- `youtube_channel_id`, OAuth refresh token (read-only scope), and `consent_at`
- `facecam_rect` `{x, y, w, h}` as a % of the 1920×1080 frame (manual in v1)
- `layout_preset`: `stack` (facecam top, gameplay bottom) | `gameplay_only` | `facecam_pip`
- `caption_language`: `en` | `hi` (Devanagari) | `hinglish` (Hindi in Latin script) | `pt-BR` | `es`
- `caption_style`: preset id
- `reaction_weights`: map of emoji or token, then weight. Seed with 😂 🤣 💀 🔥 😱 😭, "LOL", "LMAO", "OP", "GG", plus the channel's member emojis (they arrive as `:name:` text).
- `hype_phrases`: per-language list (see 4.3)
- `thresholds`: score threshold, cooldown seconds, max clips/hour
- `delivery`: `{ type: discord | telegram | drive, target }`
- `active_hours` (optional)

### 4.2 Ingest
- **Go-live detection without burning quota:**
  - Every 60s, check `https://www.youtube.com/channel/<id>/live` with streamlink/yt-dlp in "probe" mode. This costs no API quota.
  - When it resolves to a live video, call `videos.list` (part=`liveStreamingDetails`, 1 unit) once to get the `activeLiveChatId` and start time.
  - Optional: subscribe to the channel's WebSub (PubSubHubbub) feed to wake the checker faster.
  - Handle multiple concurrent broadcasts on one channel (rare, but it happens), and stop when the broadcast ends.
- **Video:** pull the live HLS at **720p60 or best available** via streamlink. ffmpeg segments it into **2s `.ts` files** with `-c copy` (no re-encode at ingest).
- **Rolling buffer:** keep the last **5 minutes** of segments on disk per stream, and delete older ones. Index segments by wall-clock time.
- Extract an audio-only stream (16kHz mono WAV chunks of 2s) for the audio and voice signals, and **low-res frames** (480p JPEG) at the configured vision rate.
- **Latency mode:** creators on "Normal latency" add 15 to 30s of delay. Chat reacts to the delayed video, so the signals stay aligned, but recommend "Low latency" to clients for faster clips.
- **Resilience:** auto-reconnect on HLS drop with backoff, log gaps, and never crash the process on one bad segment.

**Acceptance:** ingest runs for 8+ hours on one YouTube stream with no memory growth beyond 10% and less than 1% segment loss.

### 4.3 Chat ingest and signals

**Chat transport:**
- Primary: **`liveChatMessages.streamList`**, a server-streaming connection that pushes new messages with low latency. It costs 5 units per connection, so reconnect only when the stream drops.
- Fallback: `liveChatMessages.list` polling, always honoring the `pollingIntervalMillis` the API returns. Each poll costs 5 units, which is far more expensive over a long stream.
- **Super Chats, Super Stickers and memberships** arrive as chat events. Normalize them with `isPaid` and `amount`.

**Signals.** Each emits a value per second, normalized to that channel's own baseline as a **z-score against an EWMA mean and variance** (window about 10 min). A 300-viewer stream and a 30k-viewer stream are each judged on their own normal.

| Signal | Raw input | Raw value per second | Notes |
|---|---|---|---|
| `chat_rate` | Chat messages | Messages/sec | The strongest signal. Lags the real event by about 5 to 15s. |
| `chat_reaction` | Chat messages | Weighted emoji/token count/sec | Uses `reaction_weights`. Caps repeated spam from one user. |
| `chat_caps` | Chat messages | Share of all-caps / "!!!" / "??????" messages | Cheap hype detector |
| `audio_loud` | Audio chunks | RMS loudness (dB) | Use ffmpeg `astats` or compute in Node. Closest to real event time. |
| `voice_hype` | ASR transcript | Hype-phrase hits/sec | See phrase list below |
| `vision_event` | Frames | Event confidence 0..1 + label | See 4.4 |

**Hype phrases (seed lists, configurable):**
- `en`: "no way", "bro", "what", "chat", "let's go", "oh my god"
- `hi` / `hinglish`: "bhai", "kya", "arre", "oh bhai", "kya kar diya", "pagal", "bhaag"
- `pt-BR` and `es`: add when we onboard those creators

**Paid-message suppression (important for Indian streams):** Super Chats are often read out by TTS bots and trigger donation alerts, which spike audio and chat at the same time and look like a highlight. When a paid event lands at time `t`, **down-weight `audio_loud`, `voice_hype` and `chat_rate` for `t` to `t+12s`** (configurable).

**Chat lag correction:** chat peaks after the event. Estimate the event time as the **audio peak within the 20s before the chat peak**. If there's no audio peak, use `chat_peak - chat_lag_s`, where `chat_lag_s` defaults to 8 and is configurable.

### 4.4 Vision (HUD and event detection)
- **v1 (before launch):** a generic prompt to Gemini Flash on 480p frames that returns JSON:
  `{ "event": "death|arrest|police_chase|crash|explosion|mission_complete|none", "confidence": 0..1, "detail": "<10 words" }`
- **Cost control:**
  - Sparse sampling: **1 frame every 10s** normally.
  - **Burst:** when the cheap signals' combined score crosses `0.6 × threshold`, sample **1 frame every 2s** for the next 30s.
- **After launch (M4):** collect labelled GTA 6 frames from launch-week streams (the wanted-level HUD, death/bust screens, mission complete). Build per-game prompts with reference screenshots and a few-shot set, and store them as `game_profiles/gta6.json`. GTA 5 RP gets its own profile, since its HUD differs by server.
- Vision output is used for scoring **and** for title context.

### 4.5 Scorer
```
score(t) = w_chat_rate*z(chat_rate) + w_reaction*z(chat_reaction) + w_caps*z(chat_caps)
         + w_audio*z(audio_loud) + w_voice*z(voice_hype) + w_vision*vision_conf
```
- Use a smoothed score over a 3s window, after paid-message suppression.
- **Trigger** when `score ≥ threshold`, and at least 2 distinct signal families are elevated (z ≥ 1.5). This blocks single-signal false positives.
- **Cooldown** per stream (default 45s). If a new peak lands inside the cooldown, extend the current moment instead of creating a new one.
- **Moment window:** `[event_time - 20s, event_time + 15s]`. Extend the post-roll while the score stays above `0.7 × threshold`, up to a 60s max clip. Shorts allow up to 3 minutes, but under 60s performs best.
- Default weights are tunable per client. Log every signal value so the weights can be re-fit offline from approve/reject data.
- **Output:** a `moment` row with the window, score, a per-signal breakdown (the "why"), and the vision label.

### 4.6 Clipper and fast lane render
1. Wait until the post-roll segments exist on disk. This is the main latency floor.
2. Concat the segments and trim to the exact window (`-ss/-to` with a re-encode only for the cut).
3. **Vertical render (1080×1920, 30fps), by layout preset:**
   - `stack`: facecam crop (from `facecam_rect`) scaled to the top ~38%, gameplay center-crop below
   - `gameplay_only`: smart center crop
   - `facecam_pip`: gameplay full height with the facecam in a corner
4. **Captions:** ASR the clip audio with word timestamps, then generate an ASS subtitle file (2 to 4 words per line, active-word highlight, client style and language), then burn it in.
   - For `hinglish`: if the ASR returns Devanagari, run a Claude transliteration pass to Latin script while keeping the word timings.
   - Use fonts that cover Devanagari (for example Noto Sans Devanagari) for `hi`.
5. **Hook title:** Claude generates 3 title options in the client's language from the transcript, the vision label and a chat sample. The top one is burned in for the first 2s, and all 3 are stored for the operator.
6. Upload the MP4 and a thumbnail to R2, insert a `clip` row, and push to the dashboard over Supabase Realtime.

**Latency budget (moment, then clip ready):**
| Step | Target |
|---|---|
| Chat lag + scorer trigger | ~10s |
| Post-roll capture | 15s |
| Cut + vertical + captions render | ≤ 30s |
| ASR for captions | ≤ 10s |
| Upload + notify | ≤ 10s |
| **Total p50** | **≤ 120s** |

(Measured from when the moment appears on the viewer's screen. YouTube's own stream latency sits on top of this.)

### 4.7 Operator dashboard (Next.js)
- **Live board:** one column per live client. Moment cards stream in through Supabase Realtime.
- **Moment card:**
  - video preview
  - score, plus a breakdown bar per signal (the "why")
  - a flag if a paid message was suppressed in that window
  - vision label and transcript snippet
  - 3 title options
  - buttons: **Approve**, **Reject**, **Trim** (start/end ±5s nudges, then re-render), **Edit title**, **Send to premium**
- Keyboard shortcuts so operators can move fast: `A` approve, `R` reject, `←/→` trim, `1/2/3` pick a title.
- **Client settings page:** edit the config in 4.1, and test the facecam crop on a live frame.
- **Stream summary:** after the stream, a list of moments, approved clips, approval rate, and cost.
- **Costs and quota page:** cost per client, per stream and per stream-hour by provider, plus **YouTube API units used today against the daily quota**.
- **Auth:** operators only. Supabase auth with an email allowlist.

### 4.8 Delivery
- On approve, send to the client's delivery target (Discord webhook, Telegram bot or Drive folder): the MP4 (or an R2 link if it's over the size limit), the title options, and the stream timestamp.
- **End-of-stream summary message:** for example, "Stream ended: 14 moments, 6 clips approved, 3 queued for premium."
- **Later: auto-post Shorts to the creator's channel** via `videos.insert` with their upload consent. Two blockers to plan for:
  - `videos.insert` has its own small daily quota bucket by default.
  - Uploads from unverified API projects stay private until the project passes Google's API compliance audit.
  - Start that audit early if auto-posting is on the roadmap. It is not in v1.

### 4.9 Premium lane (post-stream)
- The operator picks the top 3 to 10 moments, or uses an auto-suggestion based on score plus approval.
- For each one, generate a script plus storyboard from the transcript and vision labels, then run Claude Code headless in `apps/premium/` with the HyperFrames skills (and the house `inbetween-edit` skill) to build the motion graphics edit: punch-ins, animated callouts like wanted-level stars, chapter titles.
- **Weekly compilation:** a long-form highlights video for the client's YouTube from approved clips, with simple transitions and chapter cards.
- Human review is mandatory before delivery.
- **Reuse the old Inbetween edit/review code here** rather than rebuilding it.

### 4.10 Cost and quota tracking
- Wrap every external API call (ASR, vision, Claude) in a logger that writes `{client_id, stream_id, provider, units, est_cost_usd, ts}`.
- Wrap every YouTube API call in a **quota logger** that tracks units against the daily allocation. The default is 10,000 units/day per project for most endpoints, and it resets at midnight Pacific time (about 13:30 IST).
- **Quota guardrails:**
  - Never poll the Data API for go-live. Use the no-quota live-page check.
  - Prefer `streamList` for chat, so one connection serves a whole stream.
  - Alert the operator at 70% of daily quota, and switch new streams to fallback mode at 90%.
  - Apply for a **quota increase** before going past roughly 10 concurrent clients.
- **Hard cost cap per stream:** if the cost passes the cap, degrade vision to sparse-only and alert the operator.

---

## 5. Data model (Postgres)

```sql
clients(id, name, youtube_channel_id, oauth_refresh_token_enc, consent_at, config jsonb, delivery jsonb, active bool, created_at)
streams(id, client_id, platform, video_id, live_chat_id, started_at, ended_at, game, status)
  -- platform: 'youtube' in v1 ('twitch' | 'kick' later)
moments(id, stream_id, event_ts, start_ts, end_ts, score, breakdown jsonb, paid_suppressed bool, vision_label, transcript, status, created_at)
  -- status: proposed | approved | rejected | rendering | delivered | premium
clips(id, moment_id, kind, r2_key, thumb_key, titles jsonb, chosen_title, language, duration_s, render_ms, created_at)
  -- kind: fast | premium | compilation
chat_events(stream_id, ts, author_hash, text, is_paid, amount)
  -- retain 30 days; hash authors, never store raw channel IDs of viewers
signal_samples(stream_id, ts, chat_rate, chat_reaction, chat_caps, audio_loud, voice_hype, vision_conf)
  -- 1 row per second; partition by day; retain 30 days (training data for weights)
cost_events(id, client_id, stream_id, provider, units, est_cost_usd, ts)
quota_events(id, ts, method, units)
operators(id, email, role)
```

---

## 6. Legal, consent, data

- **Only ingest channels whose owner has authorized us** through the Google OAuth flow plus a short written agreement. Store `consent_at`.
- Capturing a live stream outside YouTube's own player is restricted by YouTube's Terms unless you have permission from the rights holder. **The creator's written authorization is that permission. Keep it on file for every client.**
- Follow the **YouTube API Services Terms and Developer Policies** for all API use (chat, video metadata, quota). Review them during M1.
- **Dev testing on public streams** (for example GTA 5 RP streams before launch) is for internal tuning only. **Nothing from non-clients is ever published or shared**, and those buffers are deleted at the end of the session.
- **Viewer privacy:** store chat author IDs only as hashes, and delete chat logs after 30 days.
- **Rolling segments:** deleted after 5 min. Source clips are kept 30 days. Delivered clips are kept per the client agreement.
- **Clients own their clips.** Inbetween only produces them.
- No game memory reading, overlays or mods. Video and chat only.

---

## 7. Milestones

| Milestone | Dates | Scope | Done when |
|---|---|---|---|
| **M1: Pipe works** | Nov 8 to 10 | Monorepo, YouTube adapter (go-live probe, HLS ingest, streamList chat), rolling buffer, chat signals, simple chat-only scorer, cut raw clip, Discord alert, quota logger | On a live YouTube GTA RP stream, a raw clip hits Discord within 90s of a chat spike, runs 4h with no crash, and stays under 300 API units for that stream |
| **M2: Real clips** | Nov 11 to 14 | Audio + voice signals, paid-message suppression, multi-signal fusion, chat-lag correction, vertical render, captions in `en` / `hi` / `hinglish`, Claude titles, R2 upload, cost logger, ASR bake-off | Fast-lane clip p50 ≤ 120s, at least 40% of proposed moments judged clip-worthy on 3 test streams, and Hinglish captions readable |
| **M3: Operable** | Nov 15 to 18 | Dashboard (live board, cards, approve/trim/titles, settings, summary, costs + quota), OAuth onboarding link, Telegram/Drive delivery, onboard 2 to 3 creators | Operator approves a clip in under 30s, and 3 streams run at once for 6h |
| **Launch** | Nov 19 | Live ops on client streams | Clips delivered on launch night |
| **M4: GTA-aware** | Nov 19 to 30 | Vision v2 with the GTA 6 game profile from launch footage, weight re-fit from approve/reject data, premium lane via HyperFrames, weekly compilation | Approval rate ≥ 60%, and the first premium edits delivered |

---

## 8. Success metrics

- **Precision:** approved ÷ proposed moments. ≥ 40% at M2, ≥ 60% at M4.
- **Recall check:** compare against clips the creator or their team made manually. We should catch at least 70% of them.
- **Latency:** moment to fast clip ready, p50 ≤ 120s, p95 ≤ 240s.
- **Reliability:** ingest uptime ≥ 99% of live minutes.
- **Quota:** YouTube API units per stream-hour, tracked daily. Stay under 70% of the daily quota at peak load.
- **Unit cost:** cost per stream-hour, tracked weekly. It must stay well under the per-client retainer.
- **Business:** Shorts delivered per client per day, and views on those Shorts (the case study numbers).

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Super Chat TTS and donation alerts look like highlights | Paid-message suppression window, plus 2+ signal families required |
| YouTube API quota runs out mid-stream | No-quota go-live check, `streamList` chat, quota alerts, fallback mode, early quota increase request |
| Hinglish captions come out wrong or in the wrong script | ASR bake-off in M2, Claude transliteration pass, operator edit before delivery |
| Chat spikes from raids, bots or spam waves | Per-user spam caps, filter known bot accounts, 2+ signal families |
| Too many low-value clips | Per-client threshold, max clips/hour, and weights re-fit from operator feedback |
| GTA 6 HUD unknown before launch | Generic vision prompt until launch, then the game profile built from real footage in week 1 |
| Creators on "Normal latency" | Signals stay aligned anyway. Recommend "Low latency" during onboarding. |
| Vision or ASR costs blow up | Burst-only dense vision, per-stream cost cap, and provider abstraction to swap models |
| Stream drops or resolution changes | Reconnect with backoff, and always scale to the target size in the render |
| YouTube ToS or API policy changes | Creator authorization on file, API terms reviewed in M1, platform code isolated in the adapter |
| One machine overloaded on launch night | Load test at M3. Keep a second VPS image ready to spin up. |

---

## 10. Open questions
- [ ] Can `streamList` read chat with an API key for public streams, or does it need the creator's OAuth token? Verify in M1 against the current docs.
- [ ] ASR choice for Hindi/Hinglish: Groq Whisper vs Deepgram vs an Indic-focused provider. Decide in M2.
- [ ] Caption script for Hindi-speaking creators: Devanagari or Hinglish in Latin script? Ask each client.
- [ ] Is a 720p source enough for a crisp 1080×1920 gameplay crop? Test in M2.
- [ ] Hosting region (Mumbai vs Singapore) for ingest latency
- [ ] When to start the Google API audit for auto-posting Shorts
- [ ] When to add the Twitch adapter for US and Brazilian creators

---

## 11. Notes for Claude Code
- Build milestone by milestone, and don't start M2 until M1's "done when" passes on a real YouTube stream.
- All YouTube-specific code stays in `packages/adapters/youtube`. Nothing else imports it directly.
- Every signal, provider and render step sits behind an interface, so they can be swapped without touching the scorer.
- Log everything per second (`signal_samples`). It's the training data for the scorer.
- Count every YouTube API call. A quota bug is an outage.
- Re-check the current YouTube Data API and Live Streaming API docs (endpoints, scopes, quota costs) before implementing. Don't rely on memory.
- Keep commands non-interactive, and put all secrets in `.env` (`YOUTUBE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_ENCRYPTION_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `R2_*`, ASR provider keys, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`).
- Write a small `scripts/replay.ts` that feeds a recorded YouTube VOD plus a saved chat log through the pipeline as if it were live. Use it for tuning without waiting for streams.
