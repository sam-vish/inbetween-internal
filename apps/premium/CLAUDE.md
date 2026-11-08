# Premium lane — instructions for headless Claude Code

You are running inside `apps/premium/` to build ONE premium vertical edit for an
Inbetween client. The worker started you with a prompt naming a job folder
(`jobs/<momentId>/`).

## Inputs (read these first)
- `jobs/<id>/job.json` — creator, language, caption style, game, transcript, chat sample, title options
- `jobs/<id>/brief.json` — storyboard written for you: `hook`, `chapter_title`, time-ordered `beats`
  (`punch_in`, `callout`, `caption_emphasis`, `freeze_frame`, `text_card`, `sfx`), `style_notes`
- `jobs/<id>/source.mp4` — the raw 16:9 footage (moment window ± 2s)
- `jobs/<id>/fast.mp4` — the fast-lane vertical cut, for reference only

## How to build it
1. Use the **HyperFrames** skills (HTML compositions rendered to MP4) and the house
   **inbetween-edit** skill. Skills live in `.claude/skills/` (see README there).
   Reuse the existing Inbetween edit/review code wired into `inbetween-edit` instead of rebuilding it.
2. Composition: 1080×1920, 30 fps. Keep the source audio. Follow the beats: punch-ins on the peak,
   animated callouts (e.g. GTA wanted-level stars), the `hook` text in the first 2 seconds,
   readable captions in the client's language/script (Hinglish = Latin script; `hi` = Devanagari,
   use Noto Sans Devanagari).
3. Put compositions under `compositions/<momentId>/`.
4. Render with `npx hyperframes render` to `jobs/<id>/out/premium.mp4`.
5. Verify with `ffprobe`: 1080×1920, has audio, duration within ±1s of `job.json.durationS`.
6. Write `jobs/<id>/out/notes.md` (what you built, any deviations from the brief).

## Rules
- Never publish, upload or post anything (`npx hyperframes publish` is off-limits). The worker uploads the
  result and an operator reviews it before it reaches the client.
- Only touch `jobs/<id>/` and `compositions/<id>/`.
- Nothing from non-client streams is ever used in an edit.
