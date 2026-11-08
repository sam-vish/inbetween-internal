/**
 * Chat signals (PRD 4.3): chat_rate, chat_reaction, chat_caps.
 * Events are bucketed by publish second. Bots and per-user spam bursts are
 * excluded so raids/spam waves don't look like highlights.
 */
import type { ChatEvent, ClientConfig } from '@inbetween/shared';

export interface ChatSecondValues {
  sec: number;
  chat_rate: number;
  chat_reaction: number;
  chat_caps: number;
  messages: number;
}

interface Bucket {
  messages: number;
  reaction: number;
  caps: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const SHORTCUT_RE = /:[\p{L}\p{N}_-]+:/gu;

function collapse(word: string, to: 1 | 2): string {
  return word.replace(/(.)\1{2,}/g, to === 1 ? '$1' : '$1$1');
}

export function isHypeFormatted(text: string): boolean {
  if (/[!?]{3,}/.test(text)) return true;
  const letters = text.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase() && /[A-Z]/.test(letters);
}

export class ReactionScorer {
  private emoji = new Map<string, number>();
  private words = new Map<string, number>();
  private shortcuts = new Map<string, number>();

  constructor(private cfg: ClientConfig) {
    for (const [k, w] of Object.entries(cfg.reaction_weights)) {
      if (EMOJI_RE.test(k)) this.emoji.set(k, w);
      else if (/^:.+:$/.test(k)) this.shortcuts.set(k.toLowerCase(), w);
      else this.words.set(k.toUpperCase(), w);
    }
    for (const s of cfg.member_emojis) this.shortcuts.set(s.toLowerCase(), cfg.member_emoji_weight);
  }

  /** Weighted reaction-token count for one message, capped per token. */
  score(text: string): number {
    const cap = this.cfg.spam.per_message_token_cap;
    const counts = new Map<string, number>();
    const add = (key: string, w: number) => {
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      return c <= cap ? w : 0;
    };
    let total = 0;
    for (const m of text.matchAll(SHORTCUT_RE)) {
      const sc = m[0].toLowerCase();
      const w = this.shortcuts.get(sc) ?? (sc.startsWith(':_') ? this.cfg.member_emoji_weight * 0.5 : 0);
      if (w) total += add(sc, w);
    }
    const stripped = text.replace(SHORTCUT_RE, ' ');
    for (const { segment } of segmenter.segment(stripped)) {
      if (!EMOJI_RE.test(segment)) continue;
      const base = segment.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '');
      const w = this.emoji.get(segment) ?? this.emoji.get(base);
      if (w) total += add(base, w);
    }
    for (const raw of stripped.split(/[^\p{L}\p{N}']+/u)) {
      if (!raw) continue;
      const up = raw.toUpperCase();
      const w = this.words.get(up) ?? this.words.get(collapse(up, 1)) ?? this.words.get(collapse(up, 2));
      if (w) total += add(up, w);
    }
    return total;
  }
}

export class ChatSignalComputer {
  private buckets = new Map<number, Bucket>();
  private authorTimes = new Map<string, number[]>();
  private bots: Set<string>;
  private reaction: ReactionScorer;
  private lastSealed: number | null = null;
  dropped = { bot: 0, spam: 0, late: 0 };

  constructor(private cfg: ClientConfig) {
    this.bots = new Set(cfg.spam.bot_accounts.map((b) => b.toLowerCase()));
    this.reaction = new ReactionScorer(cfg);
  }

  /** Returns false when the event is excluded from signals (still worth storing). */
  push(ev: ChatEvent): boolean {
    const sec = Math.floor(ev.ts / 1000);
    if (this.lastSealed != null && sec <= this.lastSealed) {
      this.dropped.late++;
      return false;
    }
    if (this.bots.has(ev.authorName.toLowerCase())) {
      this.dropped.bot++;
      return false;
    }
    if (ev.kind !== 'text' && !ev.text) return true; // paid/membership without text: handled by suppression only
    const key = ev.authorId || ev.authorName;
    const times = (this.authorTimes.get(key) ?? []).filter((t) => ev.ts - t < 5000);
    times.push(ev.ts);
    this.authorTimes.set(key, times);
    if (times.length > this.cfg.spam.per_user_max_per_5s) {
      this.dropped.spam++;
      return false;
    }
    let b = this.buckets.get(sec);
    if (!b) {
      b = { messages: 0, reaction: 0, caps: 0 };
      this.buckets.set(sec, b);
    }
    b.messages++;
    b.reaction += this.reaction.score(ev.text);
    if (isHypeFormatted(ev.text)) b.caps++;
    return true;
  }

  /** Seals every second up to and including `sec`, emitting zeros for silent seconds. */
  sealUpTo(sec: number): ChatSecondValues[] {
    const out: ChatSecondValues[] = [];
    let from = this.lastSealed == null ? Math.min(sec, ...this.buckets.keys()) : this.lastSealed + 1;
    if (!Number.isFinite(from)) from = sec;
    // Never emit more than 10 minutes of backlog in one go.
    from = Math.max(from, sec - 600);
    for (let s = from; s <= sec; s++) {
      const b = this.buckets.get(s);
      this.buckets.delete(s);
      const n = b?.messages ?? 0;
      out.push({
        sec: s,
        chat_rate: n,
        chat_reaction: b?.reaction ?? 0,
        chat_caps: n ? (b!.caps / (n + 2)) : 0,
        messages: n,
      });
    }
    this.lastSealed = sec;
    // GC per-author windows occasionally.
    if (this.authorTimes.size > 50_000) this.authorTimes.clear();
    return out;
  }

  get sealedThrough() {
    return this.lastSealed;
  }
}
