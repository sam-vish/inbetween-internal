/**
 * Core domain types shared by every app and package.
 * Timestamps are epoch milliseconds unless the field name says otherwise.
 */
import type { ClientConfig, DeliveryTarget } from './config';

export type Platform = 'youtube' | 'twitch' | 'kick' | 'replay';

export const SIGNAL_NAMES = [
  'chat_rate',
  'chat_reaction',
  'chat_caps',
  'audio_loud',
  'voice_hype',
  'vision_event',
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

export type SignalFamily = 'chat' | 'audio' | 'voice' | 'vision';

export const SIGNAL_FAMILY: Record<SignalName, SignalFamily> = {
  chat_rate: 'chat',
  chat_reaction: 'chat',
  chat_caps: 'chat',
  audio_loud: 'audio',
  voice_hype: 'voice',
  vision_event: 'vision',
};

/** One per-second value from a signal worker. `sec` is an epoch second (integer). */
export interface SignalSample {
  streamId: string;
  signal: SignalName;
  sec: number;
  raw: number;
  /** z-score against the channel's EWMA baseline. Vision uses confidence 0..1 instead. */
  z: number;
  label?: string;
  detail?: string;
}

/** Bus events beyond plain samples. */
export type BusEvent =
  | { type: 'sample'; sample: SignalSample }
  | { type: 'paid'; streamId: string; ts: number; amount: number; currency?: string; kind: string }
  | { type: 'burst'; streamId: string; ts: number; untilTs: number };

export type StreamStatus = 'live' | 'ended' | 'error';

export interface StreamRecord {
  id: string;
  clientId: string;
  platform: Platform;
  videoId: string;
  liveChatId: string | null;
  title: string | null;
  startedAt: number;
  endedAt: number | null;
  game: string | null;
  status: StreamStatus;
  workerHost: string | null;
  summary: StreamSummary | null;
}

export interface StreamSummary {
  moments: number;
  approved: number;
  rejected: number;
  delivered: number;
  premium: number;
  approvalRate: number;
  costUsd: number;
  quotaUnits: number;
  durationS: number;
  costPerHourUsd: number;
}

export type MomentStatus =
  | 'detected'
  | 'rendering'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'delivered'
  | 'premium'
  | 'failed';

export interface SignalBreakdownEntry {
  raw: number;
  z: number;
  weight: number;
  contribution: number;
  suppressed: boolean;
}
export type SignalBreakdown = Partial<Record<SignalName, SignalBreakdownEntry>>;

export interface MomentRecord {
  id: string;
  streamId: string;
  clientId: string;
  eventTs: number;
  startTs: number;
  endTs: number;
  score: number;
  breakdown: SignalBreakdown;
  paidSuppressed: boolean;
  visionLabel: string | null;
  transcript: string | null;
  status: MomentStatus;
  reason: string | null;
  chatSample: string[];
  createdAt: number;
}

export type ClipKind = 'fast' | 'premium' | 'compilation';

export interface ClipRecord {
  id: string;
  momentId: string | null;
  clientId: string;
  streamId: string | null;
  kind: ClipKind;
  r2Key: string;
  thumbKey: string | null;
  sourceKey: string | null;
  titles: string[];
  chosenTitle: string | null;
  burnedTitle: string | null;
  language: string;
  durationS: number;
  renderMs: number;
  /** Window actually rendered, epoch ms. */
  startTs: number | null;
  endTs: number | null;
  needsReview: boolean;
  createdAt: number;
}

export interface ClientRecord {
  id: string;
  name: string;
  youtubeChannelId: string;
  oauthRefreshTokenEnc: string | null;
  consentAt: number | null;
  config: ClientConfig;
  delivery: DeliveryTarget;
  active: boolean;
  baseline: BaselineSnapshot | null;
  createdAt: number;
}

export interface EwmaState {
  mean: number;
  variance: number;
  n: number;
}
export type BaselineSnapshot = Partial<Record<SignalName, EwmaState>>;

export interface ChatEventRow {
  streamId: string;
  ts: number;
  authorHash: string;
  text: string;
  isPaid: boolean;
  amount: number;
  currency: string | null;
  kind: string;
}

/** One row per stream-second: the training data for the scorer. */
export interface SignalSampleRow {
  streamId: string;
  sec: number;
  chat_rate: number | null;
  chat_reaction: number | null;
  chat_caps: number | null;
  audio_loud: number | null;
  voice_hype: number | null;
  vision_conf: number | null;
  vision_label: string | null;
  z: Partial<Record<SignalName, number>>;
  score: number;
  paidSuppressed: boolean;
}

export interface CostEventRow {
  clientId: string | null;
  streamId: string | null;
  provider: string;
  units: number;
  unitType: string;
  estCostUsd: number;
  ts: number;
}

export interface QuotaEventRow {
  ts: number;
  method: string;
  units: number;
  streamId: string | null;
}

export type OperatorActionType =
  | 'approve'
  | 'reject'
  | 'trim'
  | 'title'
  | 'premium'
  | 'rerender'
  | 'deliver';

export interface OperatorAction {
  id: string;
  momentId: string | null;
  clipId: string | null;
  action: OperatorActionType;
  payload: Record<string, unknown>;
  operatorEmail: string | null;
  createdAt: number;
  processedAt: number | null;
  error: string | null;
}

export interface DeliveryRecord {
  id: string;
  clipId: string;
  clientId: string;
  targetType: string;
  status: 'pending' | 'sent' | 'failed';
  detail: string | null;
  createdAt: number;
}
