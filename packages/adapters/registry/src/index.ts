/**
 * Platform registry: the ONLY module that imports concrete platform adapters.
 * Apps depend on this + the PlatformAdapter interface, so adding Twitch/Kick
 * means a new adapter package and one line here — not a rewrite.
 */
import type { ChatEvent, Env, Logger, Platform, PlatformAdapter, QuotaLedger } from '@inbetween/shared';
import { parseYtDlpLiveChat, YouTubeAdapter } from '@inbetween/adapter-youtube';

export interface AdapterDeps {
  env: Env;
  quota: QuotaLedger;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export interface AdapterRegistry {
  get(platform: Platform): PlatformAdapter;
  has(platform: Platform): boolean;
  init(): Promise<void>;
  close(): void;
}

export function createAdapterRegistry(deps: AdapterDeps): AdapterRegistry {
  const youtube = new YouTubeAdapter({ env: deps.env, quota: deps.quota, log: deps.log.child({ platform: 'youtube' }), fetchImpl: deps.fetchImpl });
  const map = new Map<Platform, PlatformAdapter>([['youtube', youtube]]);
  return {
    get(platform) {
      const a = map.get(platform);
      if (!a) throw new Error(`no adapter for platform ${platform}`);
      return a;
    },
    has: (p) => map.has(p),
    async init() {
      await youtube.init();
    },
    close() {
      youtube.close();
    },
  };
}

/** Parses a recorded chat log for replay. `ts` of each event = ms offset from VOD start. */
export function parseRecordedChat(platform: Platform, content: string): ChatEvent[] {
  if (platform === 'youtube') return parseYtDlpLiveChat(content);
  throw new Error(`no recorded chat parser for ${platform}`);
}
