/**
 * Provider factory: every ASR / vision / LLM implementation sits behind an
 * interface so it can be swapped by env var without touching the pipeline.
 */
import type { Env, Pricing } from '@inbetween/shared';
import { DeepgramAsr } from './asr/deepgram';
import { GroqAsr } from './asr/groq';
import { MockAsr } from './asr/mock';
import { SarvamAsr } from './asr/sarvam';
import type { AsrProvider } from './asr/types';
import { ClaudeLlm, type LlmProvider, MockLlm } from './llm/index';
import { GeminiVision, MockVision, type VisionProvider } from './vision/index';

export * from './asr/types';
export { GroqAsr } from './asr/groq';
export { DeepgramAsr } from './asr/deepgram';
export { SarvamAsr } from './asr/sarvam';
export { MockAsr } from './asr/mock';
export * from './vision/index';
export * from './llm/index';

export type AsrName = 'groq' | 'deepgram' | 'sarvam' | 'mock' | 'none';

export function createAsrByName(name: AsrName, env: Env, pricing: Pricing): AsrProvider | null {
  switch (name) {
    case 'groq':
      if (!env.GROQ_API_KEY) throw new Error('ASR groq needs GROQ_API_KEY');
      return new GroqAsr(env.GROQ_API_KEY, env.GROQ_ASR_MODEL, pricing);
    case 'deepgram':
      if (!env.DEEPGRAM_API_KEY) throw new Error('ASR deepgram needs DEEPGRAM_API_KEY');
      return new DeepgramAsr(env.DEEPGRAM_API_KEY, env.DEEPGRAM_MODEL, pricing);
    case 'sarvam':
      if (!env.SARVAM_API_KEY) throw new Error('ASR sarvam needs SARVAM_API_KEY');
      return new SarvamAsr(env.SARVAM_API_KEY, env.SARVAM_MODEL, pricing);
    case 'mock':
      return new MockAsr();
    case 'none':
      return null;
  }
}

function defaultAsrName(env: Env): AsrName {
  if (env.GROQ_API_KEY) return 'groq';
  if (env.DEEPGRAM_API_KEY) return 'deepgram';
  if (env.SARVAM_API_KEY) return 'sarvam';
  return 'mock';
}

export interface Providers {
  /** Caption ASR (full clip, word timestamps). */
  asr: AsrProvider | null;
  /** Live ASR for voice_hype (short windows). */
  liveAsr: AsrProvider | null;
  vision: VisionProvider | null;
  llm: LlmProvider;
}

export function createProviders(env: Env, pricing: Pricing): Providers {
  const asrName = env.ASR_PROVIDER ?? defaultAsrName(env);
  const liveName = env.ASR_LIVE_PROVIDER ?? asrName;
  const visionName = env.VISION_PROVIDER ?? (env.GEMINI_API_KEY ? 'gemini' : 'mock');
  const llmName = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'claude' : 'mock');
  return {
    asr: createAsrByName(asrName, env, pricing),
    liveAsr: createAsrByName(liveName, env, pricing),
    vision:
      visionName === 'gemini'
        ? new GeminiVision(env.GEMINI_API_KEY ?? '', env.GEMINI_VISION_MODEL, pricing)
        : visionName === 'mock'
          ? new MockVision()
          : null,
    llm: llmName === 'claude' ? new ClaudeLlm(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL, pricing) : new MockLlm(),
  };
}
