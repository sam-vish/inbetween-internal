import { type ChatEvent, parseClientConfig, type SignalName, type SignalSampleRow } from '@inbetween/shared';
import { describe, expect, it } from 'vitest';
import { AudioLoudnessMeter, rmsDbfs } from './audio';
import { ChatSignalComputer, isHypeFormatted, ReactionScorer } from './chat';
import { EwmaBaseline, SignalNormalizer } from './ewma';
import { type MomentCandidate, MomentScorer } from './scorer';
import { HypePhraseMatcher } from './voice';

const cfg = parseClientConfig({});

describe('EWMA baseline', () => {
  it('returns 0 during warm-up then large z on spikes', () => {
    const b = new EwmaBaseline({ windowS: 600, minSamples: 30, stdFloor: 0.5, relStdFloor: 0, clampSigma: 6 });
    for (let i = 0; i < 29; i++) expect(b.observe(2 + (i % 3) * 0.5)).toBe(0);
    for (let i = 0; i < 100; i++) b.observe(2 + (i % 3) * 0.5);
    expect(Math.abs(b.z(2.5))).toBeLessThan(1.5);
    expect(b.z(12)).toBeGreaterThan(5);
  });
  it('is not dragged by a single outlier', () => {
    const b = new EwmaBaseline({ windowS: 600, minSamples: 10, stdFloor: 0.5, relStdFloor: 0, clampSigma: 6 });
    for (let i = 0; i < 200; i++) b.observe(3);
    b.observe(1000);
    expect(b.mean).toBeLessThan(3.1);
  });
  it('snapshots and restores (warm start next stream)', () => {
    const n = new SignalNormalizer(600, 60);
    for (let i = 0; i < 100; i++) n.observe('chat_rate', 4 + (i % 2));
    const snap = n.snapshot();
    const n2 = new SignalNormalizer(600, 60, snap);
    expect(n2.get('chat_rate').z(20)).toBeGreaterThan(3);
  });
});

describe('chat signals', () => {
  const ev = (ts: number, text: string, author = `a${ts}`, extra: Partial<ChatEvent> = {}): ChatEvent => ({
    id: `${ts}-${author}-${text}`,
    platform: 'youtube',
    ts,
    authorId: author,
    authorName: author,
    text,
    kind: 'text',
    isPaid: false,
    amount: 0,
    currency: null,
    ...extra,
  });

  it('scores reaction tokens with per-token caps, elongation and member emojis', () => {
    const r = new ReactionScorer(parseClientConfig({ member_emojis: [':_bhaiHype:'] }));
    expect(r.score('😂😂😂😂😂😂')).toBe(3); // capped at 3
    expect(r.score('LOOOOL')).toBeCloseTo(0.8);
    expect(r.score('GGGG')).toBeCloseTo(0.6);
    expect(r.score('lmao 💀')).toBeCloseTo(2.2);
    expect(r.score(':_bhaiHype: :_bhaiHype:')).toBe(2);
    expect(r.score('hello there')).toBe(0);
  });

  it('detects hype formatting', () => {
    expect(isHypeFormatted('NO WAY')).toBe(true);
    expect(isHypeFormatted('what???')).toBe(true);
    expect(isHypeFormatted('ok')).toBe(false);
    expect(isHypeFormatted('nice one')).toBe(false);
  });

  it('buckets per second, drops bots, spam and late events', () => {
    const c = new ChatSignalComputer(cfg);
    const t0 = 1_700_000_000_000;
    c.push(ev(t0 + 100, 'LOL'));
    c.push(ev(t0 + 200, 'NO WAY!!!'));
    c.push(ev(t0 + 300, '!song', 'Nightbot'));
    for (let i = 0; i < 5; i++) c.push(ev(t0 + 400 + i, `spam ${i}`, 'spammer'));
    c.push(ev(t0 + 1500, '😂'));
    const vals = c.sealUpTo(Math.floor(t0 / 1000) + 2);
    expect(vals.map((v) => v.chat_rate)).toEqual([4, 1, 0]); // 2 normal + 2 spammer (cap 2/5s)
    expect(c.dropped).toMatchObject({ bot: 1, spam: 3 });
    expect(c.push(ev(t0 + 500, 'late'))).toBe(false);
    expect(c.dropped.late).toBe(1);
  });
});

describe('audio + voice', () => {
  it('computes dBFS per media second', () => {
    const m = new AudioLoudnessMeter(16000);
    const loud = new Int16Array(16000).fill(16384); // -6 dBFS
    const quiet = new Int16Array(16000).fill(164); // ~-46 dBFS
    const out = m.push(Buffer.concat([Buffer.from(loud.buffer), Buffer.from(quiet.buffer), Buffer.alloc(100)]));
    expect(out).toHaveLength(2);
    expect(out[0].db).toBeCloseTo(-6.02, 1);
    expect(out[1].db).toBeLessThan(-40);
    expect(rmsDbfs(new Int16Array(10))).toBe(-100);
  });

  it('matches hype phrases (Latin, Hinglish, Devanagari), longest first', () => {
    const m = HypePhraseMatcher.forConfig(parseClientConfig({ caption_language: 'hinglish' }));
    const words = ['Oh', 'bhai', 'kya', 'kar', 'diya!', 'भाई', 'random'].map((w, i) => ({ w, start: 1000 * i, end: 1000 * i + 900 }));
    const hits = m.match(words);
    expect(hits.map((h) => h.phrase)).toEqual(['oh bhai', 'kya kar diya', 'भाई']);
    const per = m.perSecond(words, 0, 7);
    expect(per.map((p) => p.hits)).toEqual([1, 0, 1, 0, 0, 1, 0]);
  });
});

// ------------------------- scorer simulation -------------------------

/** Deterministic pseudo-random noise. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

interface Sim {
  moments: MomentCandidate[];
  extends: MomentCandidate[];
  suppressed: string[];
  rows: SignalSampleRow[];
  bursts: number[];
}

/**
 * Simulates a stream second by second: baseline noise plus scripted events.
 * Returns everything the scorer emitted.
 */
function simulate(
  durationS: number,
  script: (sec: number) => { chat?: number; text?: string; audioDb?: number; paid?: boolean; voice?: number },
  config = cfg,
): Sim {
  const t0 = 1_800_000_000; // epoch seconds
  const rand = rng(7);
  const sim: Sim = { moments: [], extends: [], suppressed: [], rows: [], bursts: [] };
  const scorer = new MomentScorer('s1', config, {
    onMoment: (m) => sim.moments.push(m),
    onExtend: (m) => sim.extends.push(m),
    onSuppressed: (_m, why) => sim.suppressed.push(why),
    onRow: (r) => sim.rows.push(r),
    onBurst: (u) => sim.bursts.push(u),
  });
  const chat = new ChatSignalComputer(config);
  const norm = new SignalNormalizer(600, 60);
  let author = 0;
  for (let i = 0; i < durationS; i++) {
    const sec = t0 + i;
    const s = script(i);
    const n = s.chat ?? Math.round(1 + rand() * 3);
    for (let k = 0; k < n; k++) {
      chat.push({
        id: `${sec}-${k}`,
        platform: 'youtube',
        ts: sec * 1000 + Math.floor((k / Math.max(1, n)) * 900),
        authorId: `u${author++}`,
        authorName: `u${author}`,
        text: s.text ?? (rand() > 0.9 ? 'lol' : 'nice'),
        kind: 'text',
        isPaid: false,
        amount: 0,
        currency: null,
      });
    }
    if (s.paid) scorer.ingestPaid(sec * 1000 + 100);
    for (const v of chat.sealUpTo(sec)) {
      for (const name of ['chat_rate', 'chat_reaction', 'chat_caps'] as SignalName[]) {
        const raw = v[name as 'chat_rate'];
        scorer.ingest({ streamId: 's1', signal: name, sec: v.sec, raw, z: norm.observe(name, raw) });
      }
    }
    const db = s.audioDb ?? -32 + rand() * 4;
    scorer.ingest({ streamId: 's1', signal: 'audio_loud', sec, raw: db, z: norm.observe('audio_loud', db) });
    const hits = s.voice ?? (rand() > 0.97 ? 1 : 0);
    scorer.ingest({ streamId: 's1', signal: 'voice_hype', sec, raw: hits, z: norm.observe('voice_hype', hits) });
    scorer.tick((sec + 1) * 1000);
  }
  scorer.flush();
  return sim;
}

const T0 = 1_800_000_000;

describe('moment scorer', () => {
  it('detects a real moment and places the event at the audio peak before the chat peak', () => {
    const E = 300; // event second
    const sim = simulate(420, (i) => {
      if (i >= E && i < E + 3) return { audioDb: -8, voice: i === E ? 2 : 0 };
      if (i >= E + 7 && i < E + 16) return { chat: 18, text: i % 2 ? 'NO WAY 😂😂' : 'LMAO 💀' };
      return {};
    });
    expect(sim.moments).toHaveLength(1);
    const m = sim.moments[0];
    expect(Math.abs(m.eventTs / 1000 - (T0 + E))).toBeLessThanOrEqual(2);
    expect(m.startTs / 1000).toBeCloseTo(m.eventTs / 1000 - 20);
    expect(m.endTs - m.eventTs).toBeGreaterThanOrEqual(15_000);
    expect(m.endTs - m.startTs).toBeLessThanOrEqual(60_000);
    expect(m.breakdown.chat_rate?.z).toBeGreaterThan(1.5);
    expect(m.breakdown.audio_loud?.z).toBeGreaterThan(1.5);
    expect(m.reason).toMatch(/audio peak/);
    expect(sim.bursts.length).toBeGreaterThan(0);
    // One signal_samples row per evaluated second.
    expect(sim.rows.length).toBeGreaterThan(400);
  });

  it('ignores a chat-only spike (needs 2+ signal families)', () => {
    const sim = simulate(400, (i) => (i >= 300 && i < 310 ? { chat: 25, text: 'LOL 😂' } : {}));
    expect(sim.moments).toHaveLength(0);
  });

  it('suppresses Super Chat TTS + donation alert spikes', () => {
    const P = 300;
    const sim = simulate(400, (i) => {
      if (i === P) return { paid: true };
      // TTS reads the donation: loud audio + voice + a burst of plain chat right after the paid event.
      if (i > P && i < P + 10) return { audioDb: -8, voice: 2, chat: 14, text: 'thanks' };
      return {};
    });
    expect(sim.moments).toHaveLength(0);
    expect(sim.rows.some((r) => r.paidSuppressed)).toBe(true);
  });

  it('extends the previous moment inside the cooldown instead of creating a new one', () => {
    const spike = (i: number, E: number) =>
      i >= E && i < E + 3 ? { audioDb: -8 } : i >= E + 7 && i < E + 14 ? { chat: 18, text: 'NO WAY 😂' } : null;
    const sim = simulate(460, (i) => spike(i, 300) ?? spike(i, 330) ?? {});
    expect(sim.moments).toHaveLength(1);
    expect(sim.extends.length).toBeGreaterThanOrEqual(1);
    const ext = sim.extends.at(-1)!;
    expect(ext.endTs).toBeGreaterThan(sim.moments[0].endTs);
    expect(ext.endTs - ext.startTs).toBeLessThanOrEqual(60_000);
  });

  it('falls back to chat peak − chat_lag_s when there is no audio peak', () => {
    const E = 300;
    const sim = simulate(420, (i) => {
      if (i >= E && i < E + 2) return { voice: 3 };
      if (i >= E + 8 && i < E + 15) return { chat: 20, text: 'NO WAY 😱😱' };
      return {};
    });
    expect(sim.moments).toHaveLength(1);
    expect(sim.moments[0].reason).toMatch(/chat peak − 8s/);
  });
});

describe('scorer soak', () => {
  it('produces no moments over an hour of ordinary chat/audio noise', () => {
    const sim = simulate(3600, () => ({}));
    expect(sim.moments).toHaveLength(0);
    expect(sim.rows.length).toBeGreaterThan(3500);
  });
});
