/**
 * Platform adapter contract (PRD 3.1). Everything platform-specific lives
 * behind this interface; the scorer, render and dashboard never import
 * platform code directly. v1 ships `@inbetween/adapter-youtube`.
 */
import type { Platform } from './types';

export interface ChannelRef {
  clientId: string;
  channelId: string;
  /** Decrypted OAuth refresh token, when the client granted one. */
  oauthRefreshToken?: string | null;
}

export interface LiveSession {
  platform: Platform;
  channelId: string;
  videoId: string;
  liveChatId: string | null;
  title: string | null;
  /** Actual broadcast start (epoch ms). */
  startedAt: number;
  /** Public watch URL, used for streamlink and stream timestamps. */
  url: string;
}

/**
 * How to obtain an MPEG-TS byte stream for the ingest worker.
 * - `command`: spawn a process that writes MPEG-TS to stdout (streamlink / yt-dlp).
 * - `file`: read a local file (replay). `realtime` throttles to the given speed.
 */
export type HlsSource =
  | { kind: 'command'; cmd: string; args: string[]; env?: Record<string, string> }
  | { kind: 'file'; path: string; speed: number };

export type ChatEventKind =
  | 'text'
  | 'paid_message'
  | 'paid_sticker'
  | 'membership'
  | 'membership_gift'
  | 'gift'
  | 'system';

/** Normalized chat event. `authorId` is the raw platform ID and must never be persisted. */
export interface ChatEvent {
  id: string;
  platform: Platform;
  /** Epoch ms when the message was published. */
  ts: number;
  authorId: string;
  authorName: string;
  text: string;
  kind: ChatEventKind;
  isPaid: boolean;
  /** Amount in `currency` major units (e.g. 100 for ₹100). 0 when not monetary. */
  amount: number;
  currency: string | null;
  amountDisplay?: string | null;
  isMember?: boolean;
  isModerator?: boolean;
  isOwner?: boolean;
}

export interface ChatOpenOptions {
  signal: AbortSignal;
  /** `stream` = server-streaming (preferred); `poll` = list polling fallback; `none` = no chat. */
  mode: 'stream' | 'poll' | 'none';
  /** Called when the transport changes (e.g. stream → poll) or ends, for logging/alerts. */
  onStatus?: (status: ChatTransportStatus) => void;
  oauthRefreshToken?: string | null;
  preferOAuth?: boolean;
  /** Attributes quota usage to a stream. */
  streamId?: string | null;
}

export interface ChatTransportStatus {
  transport: 'stream' | 'poll' | 'none';
  state: 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error' | 'fallback';
  detail?: string;
  /** Approximate delivery delay of this transport, used to size the scorer delay. */
  expectedDelayMs?: number;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  /** Returns the channel's current live session, or null. Must be cheap (no quota) when offline. */
  detectLive(channel: ChannelRef): Promise<LiveSession | null>;
  /** All concurrent live sessions for the channel (rare but possible). */
  detectAllLive?(channel: ChannelRef): Promise<LiveSession[]>;
  /** Confirms whether a session is still live (used to tell drops from real ends). */
  isStillLive?(session: LiveSession): Promise<boolean>;
  openVideo(session: LiveSession): HlsSource;
  openChat(session: LiveSession, opts: ChatOpenOptions): AsyncIterable<ChatEvent>;
  /** Builds a link to a moment inside the broadcast/VOD. */
  timestampUrl?(session: LiveSession, offsetS: number): string;
}

export class ChatEndedError extends Error {
  constructor(message = 'chat ended') {
    super(message);
    this.name = 'ChatEndedError';
  }
}
