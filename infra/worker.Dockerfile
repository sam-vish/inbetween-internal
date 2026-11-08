# Inbetween worker: ingest (streamlink → ffmpeg), signals, scorer, clipper, fast-lane render, delivery.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates fonts-noto-core fonts-noto-color-emoji tini \
 && pip3 install --no-cache-dir --break-system-packages streamlink yt-dlp \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WORKER_HTTP_PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "--filter", "@inbetween/worker", "start"]
