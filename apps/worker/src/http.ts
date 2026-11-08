/**
 * Worker HTTP server: /healthz, /metrics (JSON), /files/* (local storage
 * in dev), and the optional WebSub callback (/websub) that wakes the go-live
 * checker as soon as YouTube pushes a channel feed update.
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { LocalStorage } from '@inbetween/shared';
import type { WorkerDeps } from './deps';
import type { Supervisor } from './supervisor';

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.ts': 'video/mp2t', '.txt': 'text/plain' };

export function startHttp(deps: WorkerDeps, supervisor: Supervisor | null): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, host: deps.host, streams: supervisor?.running.length ?? 0 }));
        return;
      }
      if (url.pathname === '/metrics') {
        const [render, deliver] = await Promise.all([deps.renderQueue.counts(), deps.deliverQueue.counts()]);
        const used = await deps.quota.usedToday();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            deps.metrics.snapshot({
              host: deps.host,
              queues: { render, deliver },
              quota: { usedToday: used, dailyLimit: deps.quota.dailyLimit, mode: deps.quota.modeFor(used) },
            }),
            null,
            2,
          ),
        );
        return;
      }
      if (url.pathname.startsWith('/files/') && deps.storage instanceof LocalStorage) {
        const key = decodeURIComponent(url.pathname.slice('/files/'.length));
        const p = deps.storage.pathFor(key);
        const st = await fs.stat(p).catch(() => null);
        if (!st) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(p)] ?? 'application/octet-stream',
          'content-length': st.size,
          'access-control-allow-origin': '*',
        });
        createReadStream(p).pipe(res);
        return;
      }
      if (url.pathname === '/websub') {
        // Subscription verification
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(url.searchParams.get('hub.challenge') ?? '');
          return;
        }
        let body = '';
        for await (const c of req) body += c;
        const channelId = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
        res.writeHead(204).end();
        if (channelId && supervisor) {
          deps.log.info({ channelId }, 'websub ping: probing channel now');
          void supervisor.probeChannel(channelId).catch(() => undefined);
        }
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end(String((err as Error).message));
    }
  });
  server.listen(deps.env.WORKER_HTTP_PORT, () => deps.log.info({ port: deps.env.WORKER_HTTP_PORT }, 'worker http listening'));
  return server;
}

/** (Re)subscribes every active client's channel feed to WebSub. Leases last ~5 days. */
export async function subscribeWebSub(deps: WorkerDeps) {
  if (!deps.env.WEBSUB_ENABLED || !deps.env.PUBLIC_WORKER_URL) return;
  const clients = await deps.db.listActiveClients();
  for (const c of clients) {
    const body = new URLSearchParams({
      'hub.callback': `${deps.env.PUBLIC_WORKER_URL.replace(/\/$/, '')}/websub`,
      'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${c.youtubeChannelId}`,
      'hub.verify': 'async',
      'hub.mode': 'subscribe',
      'hub.lease_seconds': String(5 * 24 * 3600),
    });
    try {
      const r = await fetch('https://pubsubhubbub.appspot.com/subscribe', { method: 'POST', body });
      deps.log.info({ client: c.name, status: r.status }, 'websub subscribe');
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'websub subscribe failed');
    }
  }
}
