/**
 * voice_hype (PRD 4.3): hype-phrase hits per second from the live ASR
 * transcript (word timestamps). Matches Latin and Devanagari phrases,
 * longest phrase first, non-overlapping.
 */
import type { ClientConfig } from '@inbetween/shared';

export interface TimedWord {
  /** Word text as returned by ASR. */
  w: string;
  /** Absolute start/end in epoch ms. */
  start: number;
  end: number;
}

export function normalizeToken(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, '');
}

export class HypePhraseMatcher {
  private phrases: string[][];

  constructor(phrases: string[]) {
    const uniq = new Set(phrases.map((p) => p.split(/\s+/).map(normalizeToken).filter(Boolean).join(' ')).filter(Boolean));
    this.phrases = [...uniq].map((p) => p.split(' ')).sort((a, b) => b.length - a.length);
  }

  static forConfig(cfg: ClientConfig): HypePhraseMatcher {
    const lang = cfg.caption_language;
    const lists = [cfg.hype_phrases[lang] ?? [], cfg.hype_phrases.en ?? []];
    if (lang === 'hi' || lang === 'hinglish') lists.push(cfg.hype_phrases.hi ?? [], cfg.hype_phrases.hinglish ?? []);
    return new HypePhraseMatcher(lists.flat());
  }

  /** Returns the start time of every phrase hit. */
  match(words: TimedWord[]): Array<{ ts: number; phrase: string }> {
    const toks = words.map((w) => ({ ...w, n: normalizeToken(w.w) })).filter((t) => t.n);
    const hits: Array<{ ts: number; phrase: string }> = [];
    let i = 0;
    while (i < toks.length) {
      let matched = 0;
      for (const p of this.phrases) {
        if (i + p.length > toks.length) continue;
        let ok = true;
        for (let k = 0; k < p.length; k++) {
          if (toks[i + k].n !== p[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          hits.push({ ts: toks[i].start, phrase: p.join(' ') });
          matched = p.length;
          break;
        }
      }
      i += matched || 1;
    }
    return hits;
  }

  /** Per-second hit counts over [fromSec, toSec). */
  perSecond(words: TimedWord[], fromSec: number, toSec: number): Array<{ sec: number; hits: number }> {
    const counts = new Map<number, number>();
    for (const h of this.match(words)) {
      const s = Math.floor(h.ts / 1000);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const out: Array<{ sec: number; hits: number }> = [];
    for (let s = fromSec; s < toSec; s++) out.push({ sec: s, hits: counts.get(s) ?? 0 });
    return out;
  }
}
