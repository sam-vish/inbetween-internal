import { describe, expect, it } from 'vitest';
import { parseClientConfig } from '../config';
import { SupabaseDb } from './supabase';

/** Records PostgREST requests made by supabase-js and replies with canned rows. */
function fakePostgrest(reply: (url: URL, init: RequestInit) => unknown) {
  const calls: Array<{ method: string; path: string; search: URLSearchParams; body: any; headers: Headers }> = [];
  const f = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? 'GET', path: url.pathname, search: url.searchParams, body, headers: new Headers(init.headers as any) });
    return new Response(JSON.stringify(reply(url, init) ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const momentRow = {
  id: 'm1', stream_id: 's1', client_id: 'c1', event_ts: '2026-11-19T14:00:00.000Z', start_ts: '2026-11-19T13:59:40.000Z',
  end_ts: '2026-11-19T14:00:15.000Z', score: 7.5, breakdown: {}, paid_suppressed: false, vision_label: 'crash', transcript: null,
  status: 'rendering', reason: 'r', label: null, chat_sample: ['LOL'], source: null, created_at: '2026-11-19T14:00:20.000Z',
};

describe('SupabaseDb request shapes', () => {
  it('maps inserts/updates to the right tables and snake_case columns', async () => {
    const { f, calls } = fakePostgrest((url) => (url.pathname.endsWith('/moments') ? momentRow : []));
    const db = new SupabaseDb('http://sb.local', 'service-key', f);
    const m = await db.insertMoment({
      streamId: 's1', clientId: 'c1', eventTs: Date.parse(momentRow.event_ts), startTs: Date.parse(momentRow.start_ts), endTs: Date.parse(momentRow.end_ts),
      score: 7.5, breakdown: {}, paidSuppressed: false, visionLabel: 'crash', transcript: null, status: 'rendering', reason: 'r', label: null, chatSample: ['LOL'], source: null,
    });
    expect(m.eventTs).toBe(Date.parse('2026-11-19T14:00:00.000Z'));
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/rest/v1/moments');
    expect(calls[0].body).toMatchObject({ stream_id: 's1', event_ts: '2026-11-19T14:00:00.000Z', vision_label: 'crash', chat_sample: ['LOL'] });
    expect(calls[0].headers.get('apikey')).toBe('service-key');

    await db.updateMoment('m1', { status: 'proposed', label: 'police chase' });
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: '/rest/v1/moments', body: { status: 'proposed', label: 'police chase' } });
    expect(calls[1].search.get('id')).toBe('eq.m1');
  });

  it('upserts signal samples on (stream_id, ts) and calls RPCs by name', async () => {
    const { f, calls } = fakePostgrest((url) => (url.pathname.includes('/rpc/sum_quota_since') ? 42 : url.pathname.includes('/rpc/claim') ? [] : null));
    const db = new SupabaseDb('http://sb.local', 'k', f);
    await db.insertSignalSamples([
      { streamId: 's1', sec: 1_800_000_000, chat_rate: 3, chat_reaction: 1, chat_caps: 0, audio_loud: -30, voice_hype: 0, vision_conf: null, vision_label: null, z: { chat_rate: 0.4 }, score: 1.2, paidSuppressed: false },
    ]);
    expect(calls[0].path).toBe('/rest/v1/signal_samples');
    expect(calls[0].search.get('on_conflict')).toBe('stream_id,ts');
    expect(calls[0].body[0]).toMatchObject({ stream_id: 's1', ts: new Date(1_800_000_000_000).toISOString(), chat_rate: 3 });
    expect(await db.sumQuotaSince(0)).toBe(42);
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/rest/v1/rpc/sum_quota_since' });
    await db.claimOperatorActions('host-a', 5);
    expect(calls[2]).toMatchObject({ path: '/rest/v1/rpc/claim_operator_actions', body: { p_worker: 'host-a', p_limit: 5 } });
  });

  it('parses client rows through the config schema', async () => {
    const { f } = fakePostgrest(() => [
      { id: 'c1', name: 'Rahul', youtube_channel_id: 'UC1', oauth_refresh_token_enc: null, consent_at: null, config: { layout_preset: 'stack' }, delivery: { type: 'telegram', target: '-100' }, active: true, baseline: null, created_at: '2026-11-01T00:00:00Z' },
    ]);
    const [c] = await new SupabaseDb('http://sb.local', 'k', f).listActiveClients();
    expect(c.config).toEqual(parseClientConfig({ layout_preset: 'stack' }));
    expect(c.delivery).toEqual({ type: 'telegram', target: '-100' });
  });
});
