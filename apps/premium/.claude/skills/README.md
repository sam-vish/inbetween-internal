# Skills for the premium lane

Claude Code (run headless by `src/premium.ts`) loads skills from this folder.

1. **HyperFrames** — install the HyperFrames agent skills here following
   https://hyperframes.heygen.com (the CLI can report/refresh them:
   `npx hyperframes update --check --json`, `npx hyperframes update --yes`).
2. **inbetween-edit** — the house edit/review skill from the original Inbetween
   project. Copy it to `.claude/skills/inbetween-edit/` (with its `SKILL.md` and
   any scripts). The PRD asks to reuse that code rather than rebuild it, so it is
   not re-implemented in this repo.

Check the setup on the premium machine with `npx hyperframes doctor` (Chrome, FFmpeg, Node).
