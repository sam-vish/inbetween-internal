/**
 * Generates a synthetic "live stream" for end-to-end tests and tuning:
 *   vod.mp4      1280×720@30 test pattern, keyframe every 2s, quiet noise audio
 *                with loud bursts at the ground-truth event times and a TTS-like
 *                tone after a Super Chat (the decoy).
 *   chat.jsonl   baseline chat (1–3 msg/s) + reaction spikes 6–14s after each event,
 *                a Super Chat followed by plain "thanks" spam (must be suppressed).
 *   truth.json   event times + decoy time.
 *
 * Usage: tsx scripts/make-synthetic.ts [--out data/synthetic] [--duration 240]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

export interface SyntheticTruth {
  durationS: number;
  events: number[];
  paidDecoy: number;
}

export function makeSynthetic(outDir: string, durationS = 240): SyntheticTruth {
  fs.mkdirSync(outDir, { recursive: true });
  // Leave ~100s for the baseline to warm up; events well apart (> cooldown).
  const events = [95, 200].filter((e) => e + 30 < durationS);
  const paidDecoy = Math.min(durationS - 25, 145);

  // Audio: low noise floor + loud events (streamer yelling / explosion) + TTS reading the Super Chat.
  const loud = events.map((e) => `if(between(t,${e},${e + 3}),0.7*sin(2*PI*330*t)*sin(2*PI*3*t),0)`).join('+');
  const tts = `if(between(t,${paidDecoy + 1},${paidDecoy + 7}),0.6*sin(2*PI*520*t),0)`;
  const expr = `0.02*(random(0)*2-1)+${loud}+${tts}`;
  const vod = path.join(outDir, 'vod.mp4');
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${durationS}`,
      '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${durationS}`,
      '-vf', `drawtext=font='Noto Sans':text='SYNTHETIC %{pts\\:hms}':fontsize=40:fontcolor=white:x=40:y=40:box=1:boxcolor=black@0.5`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', vod,
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error('ffmpeg failed to generate the synthetic VOD');

  // Deterministic chat
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const boring = ['nice', 'hello bhai', 'first time here', 'what game is this', 'gg', 'lol', 'ok', 'kya scene hai', 'bro', 'hi chat'];
  const hype = ['NO WAY 😂😂', 'LMAO 💀💀', 'BHAI KYA KAR DIYA 😱', 'OMG!!!', 'LOOOL 🤣', 'WHAT???', 'OP OP OP 🔥'];
  const lines: string[] = [];
  let author = 0;
  for (let s = 0; s < durationS; s++) {
    const inSpike = events.some((e) => s >= e + 6 && s < e + 14);
    const afterPaid = s > paidDecoy && s < paidDecoy + 9;
    const n = inSpike ? 16 + Math.floor(rand() * 8) : afterPaid ? 12 : 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const text = inSpike ? hype[Math.floor(rand() * hype.length)] : afterPaid ? 'thanks for the superchat' : boring[Math.floor(rand() * boring.length)];
      lines.push(JSON.stringify({ t: +(s + rand() * 0.95).toFixed(3), author: `viewer${author++ % 400}`, text }));
    }
    if (s === paidDecoy) lines.push(JSON.stringify({ t: s + 0.2, author: 'bigdonor', text: 'love the stream bhai', paid: true, amount: 500, currency: 'INR' }));
  }
  lines.sort((a, b) => JSON.parse(a).t - JSON.parse(b).t);
  fs.writeFileSync(path.join(outDir, 'chat.jsonl'), lines.join('\n') + '\n');
  const truth: SyntheticTruth = { durationS, events, paidDecoy };
  fs.writeFileSync(path.join(outDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return truth;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(arg('out', 'data/synthetic'));
  const truth = makeSynthetic(out, Number(arg('duration', '240')));
  console.log(`synthetic stream written to ${out}`, truth);
}
