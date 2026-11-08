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

export type NewStream = Omit<StreamRecord, 'id' | 'summary' | 'endedAt'> & { endedAt?: number | null };
export type NewMoment = Omit<MomentRecord, 'id' | 'createdAt'>;
export type NewClip = Omit<ClipRecord, 'id' | 'createdAt'>;
export type NewClient = Omit<ClientRecord, 'id' | 'createdAt'>;

/**
 * Storage-agnostic persistence used by the worker. Implemented by
 * SupabaseDb (production) and MemoryDb (tests, offline replay).
 */
export interface Db {
  readonly kind: 'supabase' | 'memory';

  listActiveClients(): Promise<ClientRecord[]>;
  getClient(id: string): Promise<ClientRecord | null>;
  createClient(c: NewClient): Promise<ClientRecord>;
  updateClient(id: string, patch: Partial<Omit<ClientRecord, 'id'>>): Promise<void>;

  createStream(s: NewStream): Promise<StreamRecord>;
  updateStream(id: string, patch: Partial<Omit<StreamRecord, 'id'>>): Promise<void>;
  getStream(id: string): Promise<StreamRecord | null>;
  findLiveStream(clientId: string, videoId: string): Promise<StreamRecord | null>;
  listStreams(filter: { clientId?: string; status?: StreamRecord['status']; workerHost?: string }): Promise<StreamRecord[]>;

  insertMoment(m: NewMoment): Promise<MomentRecord>;
  updateMoment(id: string, patch: Partial<Omit<MomentRecord, 'id'>>): Promise<void>;
  getMoment(id: string): Promise<MomentRecord | null>;
  listMoments(streamId: string): Promise<MomentRecord[]>;
  listMomentsForClient(clientId: string, sinceTs: number, statuses?: MomentRecord['status'][]): Promise<MomentRecord[]>;

  insertClip(c: NewClip): Promise<ClipRecord>;
  updateClip(id: string, patch: Partial<Omit<ClipRecord, 'id'>>): Promise<void>;
  getClip(id: string): Promise<ClipRecord | null>;
  getLatestClip(momentId: string, kind?: ClipRecord['kind']): Promise<ClipRecord | null>;

  insertChatEvents(rows: ChatEventRow[]): Promise<void>;
  insertSignalSamples(rows: SignalSampleRow[]): Promise<void>;
  insertCostEvents(rows: CostEventRow[]): Promise<void>;
  insertQuotaEvents(rows: QuotaEventRow[]): Promise<void>;
  sumQuotaSince(ts: number): Promise<number>;
  sumCost(filter: { streamId?: string; clientId?: string; sinceTs?: number }): Promise<number>;

  insertOperatorAction(a: Omit<OperatorAction, 'id' | 'createdAt' | 'processedAt' | 'error'>): Promise<OperatorAction>;
  /** Atomically claims up to `limit` unprocessed actions for this worker. */
  claimOperatorActions(workerHost: string, limit: number): Promise<OperatorAction[]>;
  completeOperatorAction(id: string, error?: string | null): Promise<void>;

  insertDelivery(d: Omit<DeliveryRecord, 'id' | 'createdAt'>): Promise<DeliveryRecord>;
  updateDelivery(id: string, patch: Partial<Omit<DeliveryRecord, 'id'>>): Promise<void>;

  /** Creates upcoming signal_samples partitions and purges data past retention. */
  runMaintenance(): Promise<{ purged: Record<string, number> }>;

  /** Optional push channel so action processing doesn't wait for the next poll. */
  onOperatorAction?(cb: () => void): () => void;
  close?(): Promise<void>;
}
