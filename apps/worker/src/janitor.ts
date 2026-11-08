/**
 * Daily maintenance: signal_samples partitions + 30-day retention (DB),
 * and local source clips / render scratch older than retention (disk).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkerDeps } from './deps';

const SOURCE_RETENTION_MS = 30 * 24 * 3600_000;
const RENDER_SCRATCH_MS = 2 * 24 * 3600_000;

async function pruneDir(dir: string, olderThanMs: number): Promise<number> {
  let n = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - olderThanMs;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fs.rm(p, { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

export async function runJanitor(deps: WorkerDeps) {
  try {
    const r = await deps.db.runMaintenance();
    const sources = await pruneDir(path.join(deps.dataDir, 'sources'), SOURCE_RETENTION_MS);
    const renders = await pruneDir(path.join(deps.dataDir, 'renders'), RENDER_SCRATCH_MS);
    deps.log.info({ ...r.purged, localSources: sources, renderScratch: renders }, 'janitor done');
  } catch (err) {
    deps.log.error({ err: (err as Error).message }, 'janitor failed');
  }
}

export function scheduleJanitor(deps: WorkerDeps): () => void {
  const first = setTimeout(() => void runJanitor(deps), 60_000);
  const t = setInterval(() => void runJanitor(deps), 24 * 3600_000);
  first.unref();
  t.unref();
  return () => {
    clearTimeout(first);
    clearInterval(t);
  };
}
