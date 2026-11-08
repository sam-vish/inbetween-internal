import { describe, expect, it } from 'vitest';
import { isWithinActiveHours, parseClientConfig } from './config';
import { decryptSecret, encryptSecret, hashAuthor, signPayload, verifyPayload } from './crypto';
import { CostTracker, Pricing } from './cost';
import { MemoryDb } from './db/memory';
import { QuotaExceededError, QuotaLedger } from './quota';
import { formatOffset, pacificDayKey, pacificDayStart, scaledClock } from './time';

describe('client config', () => {
  it('fills nested defaults from an empty object', () => {
    const cfg = parseClientConfig({});
    expect(cfg.layout_preset).toBe('gameplay_only');
    expect(cfg.thresholds.cooldown_s).toBe(45);
    expect(cfg.timing.pre_roll_s).toBe(20);
    expect(cfg.timing.post_roll_s).toBe(15);
    expect(cfg.vision.sparse_interval_s).toBe(10);
    expect(cfg.reaction_weights['😂']).toBe(1);
    expect(cfg.hype_phrases.hinglish).toContain('kya kar diya');
  });

  it('keeps partial overrides and fills the rest', () => {
    const cfg = parseClientConfig({ thresholds: { score: 3 }, layout_preset: 'stack', facecam_rect: { x: 70, y: 0, w: 30, h: 30 } });
    expect(cfg.thresholds.score).toBe(3);
    expect(cfg.thresholds.families_required).toBe(2);
    expect(cfg.facecam_rect).toEqual({ x: 70, y: 0, w: 30, h: 30 });
  });

  it('handles active hours that wrap midnight', () => {
    const cfg = parseClientConfig({ active_hours: { tz: 'UTC', start: '22:00', end: '04:00' } });
    expect(isWithinActiveHours(cfg, new Date('2026-11-19T23:30:00Z'))).toBe(true);
    expect(isWithinActiveHours(cfg, new Date('2026-11-19T02:00:00Z'))).toBe(true);
    expect(isWithinActiveHours(cfg, new Date('2026-11-19T12:00:00Z'))).toBe(false);
  });
});

describe('crypto', () => {
  it('round-trips encrypted secrets', () => {
    const enc = encryptSecret('1//refresh-token', 'k'.repeat(40));
    expect(enc).not.toContain('refresh');
    expect(decryptSecret(enc, 'k'.repeat(40))).toBe('1//refresh-token');
    expect(() => decryptSecret(enc, 'other-key')).toThrow();
  });
  it('hashes authors deterministically without exposing the id', () => {
    const a = hashAuthor('UCabc', 'salt');
    expect(a).toBe(hashAuthor('UCabc', 'salt'));
    expect(a).not.toContain('UCabc');
    expect(hashAuthor('UCabc', 'other')).not.toBe(a);
  });
  it('signs and verifies payloads, rejecting tampering and expiry', () => {
    const tok = signPayload({ c: 'client-1', exp: Date.now() + 60_000 }, 'secret');
    expect(verifyPayload<{ c: string }>(tok, 'secret')?.c).toBe('client-1');
    expect(verifyPayload(tok, 'wrong')).toBeNull();
    expect(verifyPayload(tok.replace(/^./, 'x'), 'secret')).toBeNull();
    expect(verifyPayload(signPayload({ exp: Date.now() - 1 }, 'secret'), 'secret')).toBeNull();
  });
});

describe('time', () => {
  it('computes the Pacific quota day', () => {
    // 2026-11-19 07:59 UTC is still Nov 18 in Los Angeles (PST, UTC-8).
    expect(pacificDayKey(Date.parse('2026-11-19T07:59:00Z'))).toBe('2026-11-18');
    expect(pacificDayKey(Date.parse('2026-11-19T08:01:00Z'))).toBe('2026-11-19');
    expect(new Date(pacificDayStart(Date.parse('2026-11-19T12:00:00Z'))).toISOString()).toBe('2026-11-19T08:00:00.000Z');
    // Summer (PDT, UTC-7)
    expect(new Date(pacificDayStart(Date.parse('2026-07-01T12:00:00Z'))).toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });
  it('formats offsets', () => {
    expect(formatOffset(65)).toBe('1:05');
    expect(formatOffset(3725)).toBe('1:02:05');
  });
  it('scaled clock runs faster than wall time', () => {
    let wall = 1000;
    const c = scaledClock(50_000, 4, () => wall);
    wall += 1000;
    expect(c.now()).toBe(54_000);
  });
});

describe('quota ledger', () => {
  it('tracks units, alerts at thresholds and refuses past the limit', async () => {
    const db = new MemoryDb();
    const alerts: string[] = [];
    const q = new QuotaLedger({ db, dailyLimit: 20, onAlert: (lvl) => alerts.push(lvl) });
    await q.spend('videos.list');
    expect(await q.usedToday()).toBe(1);
    await q.spend('liveChatMessages.streamList'); // 6
    await q.spend('liveChatMessages.list'); // 11
    await q.spend('liveChatMessages.list'); // 16 -> 80% alert
    expect(alerts).toEqual(['alert']);
    await q.spend('liveChatMessages.list', { units: 2 }); // 18 -> 90% fallback
    expect(await q.mode()).toBe('fallback');
    await expect(q.spend('liveChatMessages.list')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await q.usedToday()).toBe(18);
    expect(alerts).toEqual(['alert', 'fallback', 'exhausted']);
    await q.close();
    expect(db.quotaEvents.reduce((a, e) => a + e.units, 0)).toBe(18);
  });
});

describe('cost tracker', () => {
  it('prices audio with minimum billing and fires the cap once', async () => {
    const p = new Pricing();
    expect(p.audioCost('groq:whisper-large-v3-turbo', 2)).toBeCloseTo((10 / 3600) * 0.04);
    expect(p.tokenCost('anthropic:claude-opus-5-5', 1_000_000, 100_000)).toBeCloseTo(6);
    const db = new MemoryDb();
    const t = new CostTracker(db, p, undefined, 0);
    const capped: string[] = [];
    t.onCapExceeded((s) => capped.push(s));
    t.setCap('s1', 0.5);
    const r = t.reporter({ clientId: 'c1', streamId: 's1' });
    r({ provider: 'x', units: 1, unitType: 'requests', estCostUsd: 0.4 });
    r({ provider: 'x', units: 1, unitType: 'requests', estCostUsd: 0.2 });
    r({ provider: 'x', units: 1, unitType: 'requests', estCostUsd: 0.2 });
    expect(capped).toEqual(['s1']);
    expect(t.isCapped('s1')).toBe(true);
    await t.close();
    expect(await db.sumCost({ streamId: 's1' })).toBeCloseTo(0.8);
  });
});

describe('env', () => {
  it('treats blank values (as in a copied .env.example) as unset', async () => {
    const { loadEnv } = await import('./env');
    const env = loadEnv({ ASR_PROVIDER: '', VISION_PROVIDER: '  ', YOUTUBE_DAILY_QUOTA: '', GROQ_ASR_MODEL: '' } as NodeJS.ProcessEnv, { fresh: true });
    expect(env.ASR_PROVIDER).toBeUndefined();
    expect(env.VISION_PROVIDER).toBeUndefined();
    expect(env.YOUTUBE_DAILY_QUOTA).toBe(10_000);
    expect(env.GROQ_ASR_MODEL).toBe('whisper-large-v3-turbo');
  });
  it('validates provider names', async () => {
    const { loadEnv } = await import('./env');
    expect(() => loadEnv({ ASR_PROVIDER: 'whisper' } as NodeJS.ProcessEnv, { fresh: true })).toThrow();
  });
});
