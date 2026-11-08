/** Row shapes the dashboard reads (snake_case, as returned by PostgREST). */

export interface StreamRow {
  id: string;
  client_id: string;
  platform: string;
  video_id: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  status: 'live' | 'ended' | 'error';
  summary: Record<string, number> | null;
  game: string | null;
}

export interface BreakdownEntry {
  raw: number;
  z: number;
  weight: number;
  contribution: number;
  suppressed: boolean;
}

export interface MomentRow {
  id: string;
  stream_id: string;
  client_id: string;
  event_ts: string;
  start_ts: string;
  end_ts: string;
  score: number;
  breakdown: Record<string, BreakdownEntry>;
  paid_suppressed: boolean;
  vision_label: string | null;
  transcript: string | null;
  status: 'detected' | 'rendering' | 'proposed' | 'approved' | 'rejected' | 'delivered' | 'premium' | 'failed';
  reason: string | null;
  label: string | null;
  chat_sample: string[];
  created_at: string;
}

export interface ClipRow {
  id: string;
  moment_id: string | null;
  client_id: string;
  stream_id: string | null;
  kind: 'fast' | 'premium' | 'compilation';
  r2_key: string;
  thumb_key: string | null;
  titles: string[];
  chosen_title: string | null;
  burned_title: string | null;
  language: string;
  duration_s: number | null;
  render_ms: number | null;
  needs_review: boolean;
  created_at: string;
}

export interface ClientRow {
  id: string;
  name: string;
  youtube_channel_id: string;
  oauth_channel_title: string | null;
  consent_at: string | null;
  config: Record<string, any>;
  delivery: { type: string; target: string };
  active: boolean;
  created_at: string;
}

export const CLIENT_COLUMNS = 'id,name,youtube_channel_id,oauth_channel_title,consent_at,config,delivery,active,created_at';

export const SIGNAL_COLORS: Record<string, string> = {
  chat_rate: '#4f8cff',
  chat_reaction: '#7aa7ff',
  chat_caps: '#a9c4ff',
  audio_loud: '#f5a524',
  voice_hype: '#e5484d',
  vision_event: '#30a46c',
};

export const SIGNAL_LABELS: Record<string, string> = {
  chat_rate: 'chat rate',
  chat_reaction: 'reactions',
  chat_caps: 'caps',
  audio_loud: 'audio',
  voice_hype: 'voice',
  vision_event: 'vision',
};
