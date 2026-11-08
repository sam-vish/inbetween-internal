/**
 * audio_loud (PRD 4.3): RMS loudness per second in dBFS from 16 kHz mono
 * s16le PCM. Closest signal to real event time.
 */

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;

export function rmsDbfs(samples: Int16Array): number {
  if (!samples.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/**
 * Accumulates PCM bytes and emits one loudness value per completed second
 * of media time (second index 0, 1, 2… from the start of the stream).
 */
export class AudioLoudnessMeter {
  private pending: Buffer = Buffer.alloc(0);
  private secondIndex = 0;
  private readonly bytesPerSecond: number;

  constructor(readonly sampleRate = SAMPLE_RATE) {
    this.bytesPerSecond = sampleRate * BYTES_PER_SAMPLE;
  }

  push(chunk: Buffer): Array<{ index: number; db: number }> {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Array<{ index: number; db: number }> = [];
    while (this.pending.length >= this.bytesPerSecond) {
      const sec = this.pending.subarray(0, this.bytesPerSecond);
      const samples = new Int16Array(sec.buffer.slice(sec.byteOffset, sec.byteOffset + sec.length));
      out.push({ index: this.secondIndex++, db: rmsDbfs(samples) });
      this.pending = this.pending.subarray(this.bytesPerSecond);
    }
    return out;
  }

  /** Media seconds consumed so far. */
  get mediaSeconds() {
    return this.secondIndex + this.pending.length / this.bytesPerSecond;
  }
}

/** Minimal WAV (PCM s16le mono) header so chunks can be sent to ASR providers. */
export function wavFromPcm(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
