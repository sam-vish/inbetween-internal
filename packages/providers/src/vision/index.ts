/**
 * Vision (HUD / event detection, PRD 4.4). Gemini Flash on 480p frames via
 * generateContent with a JSON schema (generationConfig.responseJsonSchema)
 * and low media resolution to keep token cost down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CostReporter, Pricing } from '@inbetween/shared';

export const VISION_EVENTS = ['death', 'arrest', 'police_chase', 'crash', 'explosion', 'mission_complete', 'none'] as const;
export type VisionEvent = (typeof VISION_EVENTS)[number];

export interface VisionResult {
  event: VisionEvent;
  confidence: number;
  detail: string;
}

export interface GameProfile {
  id: string;
  status: string;
  game: string | null;
  events: string[];
  prompt: string;
  reference_images: Array<{ path: string; label: string }>;
}

export interface VisionProvider {
  readonly name: string;
  classify(jpeg: Buffer, opts: { profile: GameProfile; cost?: CostReporter; signal?: AbortSignal }): Promise<VisionResult>;
}

const PROFILES_DIR = fileURLToPath(new URL('../../game_profiles/', import.meta.url));
const profileCache = new Map<string, GameProfile>();

export function loadGameProfile(id: string, dir = PROFILES_DIR): GameProfile {
  const hit = profileCache.get(`${dir}:${id}`);
  if (hit) return hit;
  const file = path.join(dir, `${id.replace(/[^a-z0-9_-]/gi, '')}.json`);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(path.join(dir, 'generic.json'), 'utf8');
  const profile = JSON.parse(raw) as GameProfile;
  profileCache.set(`${dir}:${id}`, profile);
  return profile;
}

export function sanitizeVisionResult(raw: any): VisionResult {
  const event = (VISION_EVENTS as readonly string[]).includes(raw?.event) ? (raw.event as VisionEvent) : 'none';
  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
  const detail = String(raw?.detail ?? '').split(/\s+/).slice(0, 10).join(' ');
  return { event, confidence: event === 'none' ? 0 : confidence, detail };
}

const SCHEMA = {
  type: 'object',
  properties: {
    event: { type: 'string', enum: [...VISION_EVENTS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    detail: { type: 'string', description: 'Under 10 words' },
  },
  required: ['event', 'confidence', 'detail'],
};

export class GeminiVision implements VisionProvider {
  readonly name = 'gemini';
  constructor(
    private apiKey: string,
    private model: string,
    private pricing: Pricing,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async classify(jpeg: Buffer, opts: { profile: GameProfile; cost?: CostReporter; signal?: AbortSignal }): Promise<VisionResult> {
    const parts: any[] = [];
    for (const ref of opts.profile.reference_images ?? []) {
      // Few-shot reference frames (M4 game profiles).
      const p = path.isAbsolute(ref.path) ? ref.path : path.join(PROFILES_DIR, ref.path);
      if (fs.existsSync(p)) {
        parts.push({ text: `Reference example: ${ref.label}` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(p).toString('base64') } });
      }
    }
    parts.push({ text: 'Frame to classify:' });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } });
    const body = {
      systemInstruction: { parts: [{ text: opts.profile.prompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: SCHEMA,
        mediaResolution: 'MEDIA_RESOLUTION_LOW',
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        maxOutputTokens: 200,
      },
    };
    const res = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(20_000),
      },
    );
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`gemini vision ${res.status}: ${json?.error?.message ?? res.statusText}`);
    const usage = json.usageMetadata ?? {};
    const inTok = Number(usage.promptTokenCount ?? 0);
    const outTok = Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0);
    opts.cost?.({
      provider: `gemini:${this.model}`,
      units: inTok + outTok,
      unitType: 'tokens',
      estCostUsd: this.pricing.tokenCost(`gemini:${this.model}`, inTok, outTok),
    });
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '{}';
    try {
      return sanitizeVisionResult(JSON.parse(text));
    } catch {
      return { event: 'none', confidence: 0, detail: 'unparseable' };
    }
  }
}

/** Offline vision: brightness spikes (explosions/flashes) read as 'explosion'. Good enough for replay plumbing. */
export class MockVision implements VisionProvider {
  readonly name = 'mock';
  async classify(jpeg: Buffer): Promise<VisionResult> {
    // Average of a sample of JPEG bytes is a crude but deterministic proxy for brightness/entropy.
    let sum = 0;
    const step = Math.max(1, Math.floor(jpeg.length / 2000));
    let n = 0;
    for (let i = 0; i < jpeg.length; i += step) {
      sum += jpeg[i];
      n++;
    }
    const avg = n ? sum / n : 0;
    return avg > 150 ? { event: 'explosion', confidence: 0.7, detail: 'bright flash (mock)' } : { event: 'none', confidence: 0, detail: '' };
  }
}
