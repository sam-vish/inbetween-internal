import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseClientConfig, parseDeliveryTarget } from '../config';
import type {
  ChatEventRow,
  ClientRecord,
  ClipRecord,
  CostEventRow,
  DeliveryRecord,
  MomentRecord,
  OperatorAction,
  QuotaEventRow,
  SignalSampleRow,
  StreamRecord,
} from '../types';
import { fromIso, iso } from '../time';
import type { Db, NewClient, NewClip, NewMoment, NewStream } from './types';

type Row = Record<string, any>;

const tsOrNull = (v: number | null | undefined) => (v == null ? null : iso(v));

// ---- row mappers (snake_case Postgres <-> camelCase domain) ----

export function clientFromRow(r: Row): ClientRecord {
  return {
    id: r.id,
    name: r.name,
    youtubeChannelId: r.youtube_channel_id,
    oauthRefreshTokenEnc: r.oauth_refresh_token_enc ?? null,
    consentAt: fromIso(r.consent_at),
    config: parseClientConfig(r.config),
    delivery: parseDeliveryTarget(r.delivery),
    active: !!r.active,
    baseline: r.baseline ?? null,
    createdAt: fromIso(r.created_at) ?? 0,
  };
}

function clientToRow(c: Partial<ClientRecord>): Row {
  const r: Row = {};
  if (c.name !== undefined) r.name = c.name;
  if (c.youtubeChannelId !== undefined) r.youtube_channel_id = c.youtubeChannelId;
  if (c.oauthRefreshTokenEnc !== undefined) r.oauth_refresh_token_enc = c.oauthRefreshTokenEnc;
  if (c.consentAt !== undefined) r.consent_at = tsOrNull(c.consentAt);
  if (c.config !== undefined) r.config = c.config;
  if (c.delivery !== undefined) r.delivery = c.delivery;
  if (c.active !== undefined) r.active = c.active;
  if (c.baseline !== undefined) r.baseline = c.baseline;
  return r;
}

export function streamFromRow(r: Row): StreamRecord {
  return {
    id: r.id,
    clientId: r.client_id,
    platform: r.platform,
    videoId: r.video_id,
    liveChatId: r.live_chat_id ?? null,
    title: r.title ?? null,
    startedAt: fromIso(r.started_at) ?? 0,
    endedAt: fromIso(r.ended_at),
    game: r.game ?? null,
    status: r.status,
    workerHost: r.worker_host ?? null,
    summary: r.summary ?? null,
  };
}

function streamToRow(s: Partial<StreamRecord>): Row {
  const r: Row = {};
  if (s.clientId !== undefined) r.client_id = s.clientId;
  if (s.platform !== undefined) r.platform = s.platform;
  if (s.videoId !== undefined) r.video_id = s.videoId;
  if (s.liveChatId !== undefined) r.live_chat_id = s.liveChatId;
  if (s.title !== undefined) r.title = s.title;
  if (s.startedAt !== undefined) r.started_at = iso(s.startedAt);
  if (s.endedAt !== undefined) r.ended_at = tsOrNull(s.endedAt);
  if (s.game !== undefined) r.game = s.game;
  if (s.status !== undefined) r.status = s.status;
  if (s.workerHost !== undefined) r.worker_host = s.workerHost;
  if (s.summary !== undefined) r.summary = s.summary;
  return r;
}

export function momentFromRow(r: Row): MomentRecord {
  return {
    id: r.id,
    streamId: r.stream_id,
    clientId: r.client_id,
    eventTs: fromIso(r.event_ts) ?? 0,
    startTs: fromIso(r.start_ts) ?? 0,
    endTs: fromIso(r.end_ts) ?? 0,
    score: Number(r.score),
    breakdown: r.breakdown ?? {},
    paidSuppressed: !!r.paid_suppressed,
    visionLabel: r.vision_label ?? null,
    transcript: r.transcript ?? null,
    status: r.status,
    reason: r.reason ?? null,
    chatSample: r.chat_sample ?? [],
    createdAt: fromIso(r.created_at) ?? 0,
  };
}

function momentToRow(m: Partial<MomentRecord>): Row {
  const r: Row = {};
  if (m.streamId !== undefined) r.stream_id = m.streamId;
  if (m.clientId !== undefined) r.client_id = m.clientId;
  if (m.eventTs !== undefined) r.event_ts = iso(m.eventTs);
  if (m.startTs !== undefined) r.start_ts = iso(m.startTs);
  if (m.endTs !== undefined) r.end_ts = iso(m.endTs);
  if (m.score !== undefined) r.score = m.score;
  if (m.breakdown !== undefined) r.breakdown = m.breakdown;
  if (m.paidSuppressed !== undefined) r.paid_suppressed = m.paidSuppressed;
  if (m.visionLabel !== undefined) r.vision_label = m.visionLabel;
  if (m.transcript !== undefined) r.transcript = m.transcript;
  if (m.status !== undefined) r.status = m.status;
  if (m.reason !== undefined) r.reason = m.reason;
  if (m.chatSample !== undefined) r.chat_sample = m.chatSample;
  return r;
}

export function clipFromRow(r: Row): ClipRecord {
  return {
    id: r.id,
    momentId: r.moment_id ?? null,
    clientId: r.client_id,
    streamId: r.stream_id ?? null,
    kind: r.kind,
    r2Key: r.r2_key,
    thumbKey: r.thumb_key ?? null,
    sourceKey: r.source_key ?? null,
    titles: r.titles ?? [],
    chosenTitle: r.chosen_title ?? null,
    burnedTitle: r.burned_title ?? null,
    language: r.language,
    durationS: Number(r.duration_s ?? 0),
    renderMs: Number(r.render_ms ?? 0),
    startTs: fromIso(r.start_ts),
    endTs: fromIso(r.end_ts),
    needsReview: !!r.needs_review,
    createdAt: fromIso(r.created_at) ?? 0,
  };
}

function clipToRow(c: Partial<ClipRecord>): Row {
  const r: Row = {};
  if (c.momentId !== undefined) r.moment_id = c.momentId;
  if (c.clientId !== undefined) r.client_id = c.clientId;
  if (c.streamId !== undefined) r.stream_id = c.streamId;
  if (c.kind !== undefined) r.kind = c.kind;
  if (c.r2Key !== undefined) r.r2_key = c.r2Key;
  if (c.thumbKey !== undefined) r.thumb_key = c.thumbKey;
  if (c.sourceKey !== undefined) r.source_key = c.sourceKey;
  if (c.titles !== undefined) r.titles = c.titles;
  if (c.chosenTitle !== undefined) r.chosen_title = c.chosenTitle;
  if (c.burnedTitle !== undefined) r.burned_title = c.burnedTitle;
  if (c.language !== undefined) r.language = c.language;
  if (c.durationS !== undefined) r.duration_s = c.durationS;
  if (c.renderMs !== undefined) r.render_ms = Math.round(c.renderMs);
  if (c.startTs !== undefined) r.start_ts = tsOrNull(c.startTs);
  if (c.endTs !== undefined) r.end_ts = tsOrNull(c.endTs);
  if (c.needsReview !== undefined) r.needs_review = c.needsReview;
  return r;
}

function actionFromRow(r: Row): OperatorAction {
  return {
    id: r.id,
    momentId: r.moment_id ?? null,
    clipId: r.clip_id ?? null,
    action: r.action,
    payload: r.payload ?? {},
    operatorEmail: r.operator_email ?? null,
    createdAt: fromIso(r.created_at) ?? 0,
    processedAt: fromIso(r.processed_at),
    error: r.error ?? null,
  };
}

function deliveryFromRow(r: Row): DeliveryRecord {
  return {
    id: r.id,
    clipId: r.clip_id,
    clientId: r.client_id,
    targetType: r.target_type,
    status: r.status,
    detail: r.detail ?? null,
    createdAt: fromIso(r.created_at) ?? 0,
  };
}

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

const CHUNK = 500;
function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export class SupabaseDb implements Db {
  readonly kind = 'supabase' as const;
  readonly sb: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.sb = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async listActiveClients() {
    const data = must(await this.sb.from('clients').select('*').eq('active', true), 'listActiveClients');
    return (data as Row[]).map(clientFromRow);
  }
  async getClient(id: string) {
    const data = must(await this.sb.from('clients').select('*').eq('id', id).maybeSingle(), 'getClient');
    return data ? clientFromRow(data) : null;
  }
  async createClient(c: NewClient) {
    const data = must(await this.sb.from('clients').insert(clientToRow(c)).select('*').single(), 'createClient');
    return clientFromRow(data);
  }
  async updateClient(id: string, patch: Partial<ClientRecord>) {
    must(await this.sb.from('clients').update(clientToRow(patch)).eq('id', id), 'updateClient');
  }

  async createStream(s: NewStream) {
    const data = must(await this.sb.from('streams').insert(streamToRow(s)).select('*').single(), 'createStream');
    return streamFromRow(data);
  }
  async updateStream(id: string, patch: Partial<StreamRecord>) {
    must(await this.sb.from('streams').update(streamToRow(patch)).eq('id', id), 'updateStream');
  }
  async getStream(id: string) {
    const data = must(await this.sb.from('streams').select('*').eq('id', id).maybeSingle(), 'getStream');
    return data ? streamFromRow(data) : null;
  }
  async findLiveStream(clientId: string, videoId: string) {
    const data = must(
      await this.sb
        .from('streams')
        .select('*')
        .eq('client_id', clientId)
        .eq('video_id', videoId)
        .eq('status', 'live')
        .order('started_at', { ascending: false })
        .limit(1),
      'findLiveStream',
    ) as Row[];
    return data[0] ? streamFromRow(data[0]) : null;
  }
  async listStreams(filter: { clientId?: string; status?: StreamRecord['status']; workerHost?: string }) {
    let q = this.sb.from('streams').select('*');
    if (filter.clientId) q = q.eq('client_id', filter.clientId);
    if (filter.status) q = q.eq('status', filter.status);
    if (filter.workerHost) q = q.eq('worker_host', filter.workerHost);
    const data = must(await q.order('started_at', { ascending: false }).limit(200), 'listStreams') as Row[];
    return data.map(streamFromRow);
  }

  async insertMoment(m: NewMoment) {
    const data = must(await this.sb.from('moments').insert(momentToRow(m)).select('*').single(), 'insertMoment');
    return momentFromRow(data);
  }
  async updateMoment(id: string, patch: Partial<MomentRecord>) {
    must(await this.sb.from('moments').update(momentToRow(patch)).eq('id', id), 'updateMoment');
  }
  async getMoment(id: string) {
    const data = must(await this.sb.from('moments').select('*').eq('id', id).maybeSingle(), 'getMoment');
    return data ? momentFromRow(data) : null;
  }
  async listMoments(streamId: string) {
    const data = must(
      await this.sb.from('moments').select('*').eq('stream_id', streamId).order('event_ts'),
      'listMoments',
    ) as Row[];
    return data.map(momentFromRow);
  }
  async listMomentsForClient(clientId: string, sinceTs: number, statuses?: MomentRecord['status'][]) {
    let q = this.sb.from('moments').select('*').eq('client_id', clientId).gte('event_ts', iso(sinceTs));
    if (statuses?.length) q = q.in('status', statuses);
    const data = must(await q.order('event_ts'), 'listMomentsForClient') as Row[];
    return data.map(momentFromRow);
  }

  async insertClip(c: NewClip) {
    const data = must(await this.sb.from('clips').insert(clipToRow(c)).select('*').single(), 'insertClip');
    return clipFromRow(data);
  }
  async updateClip(id: string, patch: Partial<ClipRecord>) {
    must(await this.sb.from('clips').update(clipToRow(patch)).eq('id', id), 'updateClip');
  }
  async getClip(id: string) {
    const data = must(await this.sb.from('clips').select('*').eq('id', id).maybeSingle(), 'getClip');
    return data ? clipFromRow(data) : null;
  }
  async getLatestClip(momentId: string, kind?: ClipRecord['kind']) {
    let q = this.sb.from('clips').select('*').eq('moment_id', momentId);
    if (kind) q = q.eq('kind', kind);
    const data = must(await q.order('created_at', { ascending: false }).limit(1), 'getLatestClip') as Row[];
    return data[0] ? clipFromRow(data[0]) : null;
  }

  async insertChatEvents(rows: ChatEventRow[]) {
    for (const part of chunks(rows)) {
      must(
        await this.sb.from('chat_events').insert(
          part.map((r) => ({
            stream_id: r.streamId,
            ts: iso(r.ts),
            author_hash: r.authorHash,
            text: r.text,
            is_paid: r.isPaid,
            amount: r.amount,
            currency: r.currency,
            kind: r.kind,
          })),
        ),
        'insertChatEvents',
      );
    }
  }

  async insertSignalSamples(rows: SignalSampleRow[]) {
    for (const part of chunks(rows)) {
      must(
        await this.sb.from('signal_samples').upsert(
          part.map((r) => ({
            stream_id: r.streamId,
            ts: iso(r.sec * 1000),
            chat_rate: r.chat_rate,
            chat_reaction: r.chat_reaction,
            chat_caps: r.chat_caps,
            audio_loud: r.audio_loud,
            voice_hype: r.voice_hype,
            vision_conf: r.vision_conf,
            vision_label: r.vision_label,
            z: r.z,
            score: r.score,
            paid_suppressed: r.paidSuppressed,
          })),
          { onConflict: 'stream_id,ts', ignoreDuplicates: true },
        ),
        'insertSignalSamples',
      );
    }
  }

  async insertCostEvents(rows: CostEventRow[]) {
    for (const part of chunks(rows)) {
      must(
        await this.sb.from('cost_events').insert(
          part.map((r) => ({
            client_id: r.clientId,
            stream_id: r.streamId,
            provider: r.provider,
            units: r.units,
            unit_type: r.unitType,
            est_cost_usd: r.estCostUsd,
            ts: iso(r.ts),
          })),
        ),
        'insertCostEvents',
      );
    }
  }

  async insertQuotaEvents(rows: QuotaEventRow[]) {
    for (const part of chunks(rows)) {
      must(
        await this.sb
          .from('quota_events')
          .insert(part.map((r) => ({ ts: iso(r.ts), method: r.method, units: r.units, stream_id: r.streamId }))),
        'insertQuotaEvents',
      );
    }
  }

  async sumQuotaSince(ts: number) {
    const data = must(await this.sb.rpc('sum_quota_since', { p_since: iso(ts) }), 'sumQuotaSince');
    return Number(data ?? 0);
  }

  async sumCost(filter: { streamId?: string; clientId?: string; sinceTs?: number }) {
    const data = must(
      await this.sb.rpc('sum_cost', {
        p_stream_id: filter.streamId ?? null,
        p_client_id: filter.clientId ?? null,
        p_since: filter.sinceTs ? iso(filter.sinceTs) : null,
      }),
      'sumCost',
    );
    return Number(data ?? 0);
  }

  async insertOperatorAction(a: Omit<OperatorAction, 'id' | 'createdAt' | 'processedAt' | 'error'>) {
    const data = must(
      await this.sb
        .from('operator_actions')
        .insert({
          moment_id: a.momentId,
          clip_id: a.clipId,
          action: a.action,
          payload: a.payload,
          operator_email: a.operatorEmail,
        })
        .select('*')
        .single(),
      'insertOperatorAction',
    );
    return actionFromRow(data);
  }

  async claimOperatorActions(workerHost: string, limit: number) {
    const data = must(
      await this.sb.rpc('claim_operator_actions', { p_worker: workerHost, p_limit: limit }),
      'claimOperatorActions',
    ) as Row[];
    return (data ?? []).map(actionFromRow);
  }

  async completeOperatorAction(id: string, error?: string | null) {
    must(
      await this.sb
        .from('operator_actions')
        .update({ processed_at: new Date().toISOString(), error: error ?? null })
        .eq('id', id),
      'completeOperatorAction',
    );
  }

  async insertDelivery(d: Omit<DeliveryRecord, 'id' | 'createdAt'>) {
    const data = must(
      await this.sb
        .from('deliveries')
        .insert({ clip_id: d.clipId, client_id: d.clientId, target_type: d.targetType, status: d.status, detail: d.detail })
        .select('*')
        .single(),
      'insertDelivery',
    );
    return deliveryFromRow(data);
  }

  async updateDelivery(id: string, patch: Partial<DeliveryRecord>) {
    const r: Row = {};
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.detail !== undefined) r.detail = patch.detail;
    must(await this.sb.from('deliveries').update(r).eq('id', id), 'updateDelivery');
  }

  async runMaintenance() {
    const data = must(await this.sb.rpc('ib_maintenance'), 'runMaintenance') as Record<string, number> | null;
    return { purged: data ?? {} };
  }

  onOperatorAction(cb: () => void) {
    const channel = this.sb
      .channel('ib-operator-actions')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'operator_actions' }, () => cb())
      .subscribe();
    return () => {
      void this.sb.removeChannel(channel);
    };
  }

  async close() {
    await this.sb.removeAllChannels();
  }
}
