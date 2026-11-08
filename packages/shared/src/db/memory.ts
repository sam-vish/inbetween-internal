import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
import type { Db, NewClient, NewClip, NewMoment, NewStream } from './types';

const RETENTION_MS = 30 * 24 * 3600_000;

/** In-process DB for tests and offline replay. Not durable. */
export class MemoryDb implements Db {
  readonly kind = 'memory' as const;
  clients = new Map<string, ClientRecord>();
  streams = new Map<string, StreamRecord>();
  moments = new Map<string, MomentRecord>();
  clips = new Map<string, ClipRecord>();
  chatEvents: ChatEventRow[] = [];
  signalSamples: SignalSampleRow[] = [];
  costEvents: CostEventRow[] = [];
  quotaEvents: QuotaEventRow[] = [];
  actions = new Map<string, OperatorAction & { claimedBy?: string }>();
  deliveries = new Map<string, DeliveryRecord>();
  private events = new EventEmitter();

  async listActiveClients() {
    return [...this.clients.values()].filter((c) => c.active);
  }
  async getClient(id: string) {
    return this.clients.get(id) ?? null;
  }
  async createClient(c: NewClient) {
    const rec: ClientRecord = { ...c, id: randomUUID(), createdAt: Date.now() };
    this.clients.set(rec.id, rec);
    return rec;
  }
  async updateClient(id: string, patch: Partial<ClientRecord>) {
    const cur = this.clients.get(id);
    if (cur) this.clients.set(id, { ...cur, ...patch });
  }

  async createStream(s: NewStream) {
    const rec: StreamRecord = { endedAt: null, summary: null, ...s, id: randomUUID() };
    this.streams.set(rec.id, rec);
    return rec;
  }
  async updateStream(id: string, patch: Partial<StreamRecord>) {
    const cur = this.streams.get(id);
    if (cur) this.streams.set(id, { ...cur, ...patch });
  }
  async getStream(id: string) {
    return this.streams.get(id) ?? null;
  }
  async findLiveStream(clientId: string, videoId: string) {
    return [...this.streams.values()].find((s) => s.clientId === clientId && s.videoId === videoId && s.status === 'live') ?? null;
  }
  async listStreams(filter: { clientId?: string; status?: StreamRecord['status']; workerHost?: string }) {
    return [...this.streams.values()].filter(
      (s) =>
        (!filter.clientId || s.clientId === filter.clientId) &&
        (!filter.status || s.status === filter.status) &&
        (!filter.workerHost || s.workerHost === filter.workerHost),
    );
  }

  async insertMoment(m: NewMoment) {
    const rec: MomentRecord = { ...m, id: randomUUID(), createdAt: Date.now() };
    this.moments.set(rec.id, rec);
    return rec;
  }
  async updateMoment(id: string, patch: Partial<MomentRecord>) {
    const cur = this.moments.get(id);
    if (cur) this.moments.set(id, { ...cur, ...patch });
  }
  async getMoment(id: string) {
    return this.moments.get(id) ?? null;
  }
  async listMoments(streamId: string) {
    return [...this.moments.values()].filter((m) => m.streamId === streamId).sort((a, b) => a.eventTs - b.eventTs);
  }
  async listMomentsForClient(clientId: string, sinceTs: number, statuses?: MomentRecord['status'][]) {
    return [...this.moments.values()]
      .filter((m) => m.clientId === clientId && m.eventTs >= sinceTs && (!statuses || statuses.includes(m.status)))
      .sort((a, b) => a.eventTs - b.eventTs);
  }

  async insertClip(c: NewClip) {
    const rec: ClipRecord = { ...c, id: randomUUID(), createdAt: Date.now() };
    this.clips.set(rec.id, rec);
    return rec;
  }
  async updateClip(id: string, patch: Partial<ClipRecord>) {
    const cur = this.clips.get(id);
    if (cur) this.clips.set(id, { ...cur, ...patch });
  }
  async getClip(id: string) {
    return this.clips.get(id) ?? null;
  }
  async getLatestClip(momentId: string, kind?: ClipRecord['kind']) {
    const list = [...this.clips.values()]
      .filter((c) => c.momentId === momentId && (!kind || c.kind === kind))
      .sort((a, b) => b.createdAt - a.createdAt);
    return list[0] ?? null;
  }

  async insertChatEvents(rows: ChatEventRow[]) {
    this.chatEvents.push(...rows);
  }
  async insertSignalSamples(rows: SignalSampleRow[]) {
    this.signalSamples.push(...rows);
  }
  async insertCostEvents(rows: CostEventRow[]) {
    this.costEvents.push(...rows);
  }
  async insertQuotaEvents(rows: QuotaEventRow[]) {
    this.quotaEvents.push(...rows);
  }
  async sumQuotaSince(ts: number) {
    return this.quotaEvents.filter((q) => q.ts >= ts).reduce((a, q) => a + q.units, 0);
  }
  async sumCost(filter: { streamId?: string; clientId?: string; sinceTs?: number }) {
    return this.costEvents
      .filter(
        (c) =>
          (!filter.streamId || c.streamId === filter.streamId) &&
          (!filter.clientId || c.clientId === filter.clientId) &&
          (!filter.sinceTs || c.ts >= filter.sinceTs),
      )
      .reduce((a, c) => a + c.estCostUsd, 0);
  }

  async insertOperatorAction(a: Omit<OperatorAction, 'id' | 'createdAt' | 'processedAt' | 'error'>) {
    const rec: OperatorAction = { ...a, id: randomUUID(), createdAt: Date.now(), processedAt: null, error: null };
    this.actions.set(rec.id, rec);
    this.events.emit('action');
    return rec;
  }
  async claimOperatorActions(workerHost: string, limit: number) {
    const out: OperatorAction[] = [];
    for (const a of [...this.actions.values()].sort((x, y) => x.createdAt - y.createdAt)) {
      if (out.length >= limit) break;
      if (a.processedAt == null && !a.claimedBy) {
        a.claimedBy = workerHost;
        out.push(a);
      }
    }
    return out;
  }
  async completeOperatorAction(id: string, error?: string | null) {
    const a = this.actions.get(id);
    if (a) {
      a.processedAt = Date.now();
      a.error = error ?? null;
    }
  }

  async insertDelivery(d: Omit<DeliveryRecord, 'id' | 'createdAt'>) {
    const rec: DeliveryRecord = { ...d, id: randomUUID(), createdAt: Date.now() };
    this.deliveries.set(rec.id, rec);
    return rec;
  }
  async updateDelivery(id: string, patch: Partial<DeliveryRecord>) {
    const cur = this.deliveries.get(id);
    if (cur) this.deliveries.set(id, { ...cur, ...patch });
  }

  async runMaintenance() {
    const cutoff = Date.now() - RETENTION_MS;
    const beforeChat = this.chatEvents.length;
    const beforeSig = this.signalSamples.length;
    this.chatEvents = this.chatEvents.filter((c) => c.ts >= cutoff);
    this.signalSamples = this.signalSamples.filter((s) => s.sec * 1000 >= cutoff);
    return {
      purged: { chat_events: beforeChat - this.chatEvents.length, signal_samples: beforeSig - this.signalSamples.length },
    };
  }

  onOperatorAction(cb: () => void) {
    this.events.on('action', cb);
    return () => this.events.off('action', cb);
  }
}
