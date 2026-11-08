import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '@inbetween/shared';
import { describe, expect, it } from 'vitest';
import { type ClipDelivery, clipCaption, DeliveryRouter, DiscordDeliverer, safeName, TelegramDeliverer } from './index';

async function clip(sizeBytes: number): Promise<ClipDelivery> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-deliv-'));
  const p = path.join(dir, 'c.mp4');
  await fs.writeFile(p, Buffer.alloc(sizeBytes, 1));
  return {
    clientName: 'Rahul',
    chosenTitle: 'Bhai ne kya kar diya 💀',
    titles: ['Bhai ne kya kar diya 💀', 'Chat went feral', 'Ye kaise hua?!'],
    videoPath: p,
    videoUrl: 'https://r2.example/clip.mp4',
    durationS: 34.6,
    streamOffsetLabel: '1:23:45',
    streamUrl: 'https://www.youtube.com/watch?v=abc&t=5025s',
    kind: 'fast',
  };
}

function capture() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: any, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, id: 'x' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('delivery', () => {
  it('builds a caption with all titles and the stream timestamp', async () => {
    const c = clipCaption(await clip(10));
    expect(c).toContain('🎬 Bhai ne kya kar diya 💀');
    expect(c).toContain('• Chat went feral');
    expect(c).toContain('1:23:45 into the stream · 35s');
    expect(safeName('Bhai ne kya kar diya 💀 / ?', 'mp4')).toBe('Bhai-ne-kya-kar-diya.mp4');
  });

  it('uploads small clips to Discord and links big ones', async () => {
    const { f, calls } = capture();
    const d = new DiscordDeliverer(1, f);
    expect((await d.sendClip('https://discord.com/api/webhooks/1/x', await clip(1000))).mode).toBe('upload');
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect(new URL(calls[0].url).searchParams.get('wait')).toBe('true');
    expect((await d.sendClip('https://discord.com/api/webhooks/1/x', await clip(2 * 1024 * 1024))).mode).toBe('link');
    expect(String(calls[1].init.body)).toContain('https://r2.example/clip.mp4');
  });

  it('uses Telegram sendVideo with the caption', async () => {
    const { f, calls } = capture();
    const t = new TelegramDeliverer('TOKEN', 50, f);
    await t.sendClip('-100123', await clip(1000));
    expect(calls[0].url).toBe('https://api.telegram.org/botTOKEN/sendVideo');
    const form = calls[0].init.body as FormData;
    expect(form.get('chat_id')).toBe('-100123');
    expect(String(form.get('caption'))).toContain('Bhai ne kya kar diya');
  });

  it('routes by target type and falls back to local delivery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-local-'));
    const r = new DeliveryRouter({ discordMaxUploadMb: 10, telegramMaxUploadMb: 50, localDir: dir, log: getLogger('t') });
    expect(r.for({ type: 'discord', target: 'https://x' }).deliverer.type).toBe('discord');
    expect(() => r.for({ type: 'telegram', target: '1' })).toThrow(/TELEGRAM_BOT_TOKEN/);
    const local = r.for({ type: 'none', target: '' });
    const res = await local.deliverer.sendClip('', await clip(100));
    expect((await fs.stat(res.detail)).size).toBe(100);
  });
});
