/**
 * Run one premium job by hand:
 *   pnpm --filter @inbetween/premium run-job <momentId> [--brief-only]
 * --brief-only prepares the job folder and brief.json without invoking Claude Code.
 */
import { loadEnv } from '@inbetween/shared';
import { createDeps } from '@inbetween/worker';
import { runPremiumJob } from './premium';

const momentId = process.argv[2];
if (!momentId) {
  console.error('usage: run-job <momentId> [--brief-only]');
  process.exit(2);
}
const deps = await createDeps(loadEnv());
try {
  const r = await runPremiumJob(deps, momentId, { skipClaudeCode: process.argv.includes('--brief-only') });
  console.log(JSON.stringify({ clipId: r.clipId, out: r.outPath, brief: r.brief }, null, 2));
} finally {
  await deps.close();
}
process.exit(0);
