# Premium lane: Claude Code (headless) + HyperFrames. Heavier image (Chrome via HyperFrames).
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-noto-core fonts-noto-color-emoji tini \
      libnss3 libatk-bridge2.0-0 libgbm1 libxkbcommon0 libgtk-3-0 libasound2 \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "--filter", "@inbetween/premium", "worker"]
