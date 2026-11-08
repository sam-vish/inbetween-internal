/**
 * Delivery (PRD 4.8): on approve, send the MP4 (or an R2 link when it is over
 * the platform's upload limit), the title options and the stream timestamp
 * to the client's Discord webhook, Telegram chat or Google Drive folder.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeliveryTarget, Logger } from '@inbetween/shared';
import { GoogleAuth } from 'google-auth-library';

export interface ClipDelivery {
  clientName: string;
  chosenTitle: string;
  titles: string[];
  videoPath: string;
  videoUrl: string;
  thumbUrl?: string | null;
  durationS: number;
  /** "1:23:45 into the stream" style label. */
  streamOffsetLabel: string;
  /** Link to the moment in the broadcast/VOD. */
  streamUrl?: string | null;
  momentLabel?: string | null;
  kind: 'fast' | 'premium' | 'compilation';
}

export interface DeliveryResult {
  ok: boolean;
  mode: 'upload' | 'link';
  detail: string;
}

export interface Deliverer {
  readonly type: DeliveryTarget['type'];
  sendClip(target: string, d: ClipDelivery): Promise<DeliveryResult>;
  sendText(target: string, text: string): Promise<DeliveryResult>;
}

export function clipCaption(d: ClipDelivery): string {
  const alt = d.titles.filter((t) => t !== d.chosenTitle);
  return [
    `🎬 ${d.chosenTitle}`,
    alt.length ? `Other titles:\n${alt.map((t) => `• ${t}`).join('\n')}` : null,
    `⏱ ${d.streamOffsetLabel} into the stream · ${Math.round(d.durationS)}s${d.kind !== 'fast' ? ` · ${d.kind}` : ''}`,
    d.streamUrl ? `🔗 ${d.streamUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function fileSizeMb(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size / (1024 * 1024);
  } catch {
    return Infinity;
  }
}

export class DiscordDeliverer implements Deliverer {
  readonly type = 'discord' as const;
  constructor(
    private maxUploadMb: number,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(url: string, body: RequestInit['body'], headers?: Record<string, string>) {
    const u = new URL(url);
    u.searchParams.set('wait', 'true');
    const res = await this.fetchImpl(u, { method: 'POST', body, headers, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`discord webhook ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async sendClip(webhookUrl: string, d: ClipDelivery): Promise<DeliveryResult> {
    const caption = clipCaption(d);
    if ((await fileSizeMb(d.videoPath)) <= this.maxUploadMb) {
      const form = new FormData();
      form.set('payload_json', JSON.stringify({ content: caption.slice(0, 1900) }));
      const buf = await fs.readFile(d.videoPath);
      form.set('files[0]', new Blob([new Uint8Array(buf)], { type: 'video/mp4' }), safeName(d.chosenTitle, 'mp4'));
      await this.post(webhookUrl, form);
      return { ok: true, mode: 'upload', detail: 'discord upload' };
    }
    await this.post(webhookUrl, JSON.stringify({ content: `${caption}\n⬇️ ${d.videoUrl}`.slice(0, 1990) }), {
      'content-type': 'application/json',
    });
    return { ok: true, mode: 'link', detail: 'discord link (over upload limit)' };
  }

  async sendText(webhookUrl: string, text: string): Promise<DeliveryResult> {
    await this.post(webhookUrl, JSON.stringify({ content: text.slice(0, 1990) }), { 'content-type': 'application/json' });
    return { ok: true, mode: 'link', detail: 'discord message' };
  }
}

export class TelegramDeliverer implements Deliverer {
  readonly type = 'telegram' as const;
  constructor(
    private botToken: string,
    private maxUploadMb: number,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, body: RequestInit['body'], headers?: Record<string, string>) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: 'POST',
      body,
      headers,
      signal: AbortSignal.timeout(180_000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !json.ok) throw new Error(`telegram ${method} ${res.status}: ${json.description ?? ''}`);
    return json;
  }

  async sendClip(chatId: string, d: ClipDelivery): Promise<DeliveryResult> {
    const caption = clipCaption(d).slice(0, 1000);
    if ((await fileSizeMb(d.videoPath)) <= this.maxUploadMb) {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('caption', caption);
      form.set('supports_streaming', 'true');
      const buf = await fs.readFile(d.videoPath);
      form.set('video', new Blob([new Uint8Array(buf)], { type: 'video/mp4' }), safeName(d.chosenTitle, 'mp4'));
      await this.call('sendVideo', form);
      return { ok: true, mode: 'upload', detail: 'telegram sendVideo' };
    }
    await this.call('sendMessage', JSON.stringify({ chat_id: chatId, text: `${caption}\n⬇️ ${d.videoUrl}` }), {
      'content-type': 'application/json',
    });
    return { ok: true, mode: 'link', detail: 'telegram link (over upload limit)' };
  }

  async sendText(chatId: string, text: string): Promise<DeliveryResult> {
    await this.call('sendMessage', JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }), {
      'content-type': 'application/json',
    });
    return { ok: true, mode: 'link', detail: 'telegram message' };
  }
}

/**
 * Google Drive via a service account. Share each client's folder with the
 * service account's email; `target` is the folder ID. Uses the resumable
 * upload protocol (multipart uploads are limited to 5 MB).
 */
export class DriveDeliverer implements Deliverer {
  readonly type = 'drive' as const;
  private auth: GoogleAuth;
  constructor(
    serviceAccountJson: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    const credentials = serviceAccountJson.trim().startsWith('{') ? JSON.parse(serviceAccountJson) : undefined;
    this.auth = new GoogleAuth({
      ...(credentials ? { credentials } : { keyFile: serviceAccountJson }),
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  }

  private async token() {
    const client = await this.auth.getClient();
    const t = await client.getAccessToken();
    if (!t.token) throw new Error('drive: could not obtain access token');
    return t.token;
  }

  private async upload(folderId: string, name: string, mime: string, data: Buffer, description?: string) {
    const token = await this.token();
    const init = await this.fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': mime,
        'x-upload-content-length': String(data.length),
      },
      body: JSON.stringify({ name, parents: [folderId], description }),
    });
    if (!init.ok) throw new Error(`drive init ${init.status}: ${(await init.text()).slice(0, 300)}`);
    const location = init.headers.get('location');
    if (!location) throw new Error('drive: no resumable session URL');
    const put = await this.fetchImpl(location, {
      method: 'PUT',
      headers: { 'content-type': mime, 'content-length': String(data.length) },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(300_000),
    });
    if (!put.ok) throw new Error(`drive upload ${put.status}: ${(await put.text()).slice(0, 300)}`);
    return (await put.json()) as { id: string };
  }

  async sendClip(folderId: string, d: ClipDelivery): Promise<DeliveryResult> {
    const buf = await fs.readFile(d.videoPath);
    const file = await this.upload(folderId, safeName(d.chosenTitle, 'mp4'), 'video/mp4', buf, clipCaption(d));
    return { ok: true, mode: 'upload', detail: `drive file ${file.id}` };
  }

  async sendText(folderId: string, text: string): Promise<DeliveryResult> {
    const name = `stream-summary-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
    const file = await this.upload(folderId, name, 'text/plain', Buffer.from(text, 'utf8'));
    return { ok: true, mode: 'upload', detail: `drive file ${file.id}` };
  }
}

/** Dev/replay deliverer: copies clips into a local folder and logs. */
export class LocalDeliverer implements Deliverer {
  readonly type = 'none' as const;
  constructor(
    private dir: string,
    private log: Logger,
  ) {}
  async sendClip(_target: string, d: ClipDelivery): Promise<DeliveryResult> {
    await fs.mkdir(this.dir, { recursive: true });
    const dest = path.join(this.dir, `${Date.now()}-${safeName(d.chosenTitle, 'mp4')}`);
    await fs.copyFile(d.videoPath, dest);
    await fs.writeFile(`${dest}.txt`, clipCaption(d));
    this.log.info({ dest }, 'clip delivered locally');
    return { ok: true, mode: 'upload', detail: dest };
  }
  async sendText(_target: string, text: string): Promise<DeliveryResult> {
    await fs.mkdir(this.dir, { recursive: true });
    const dest = path.join(this.dir, `${Date.now()}-summary.txt`);
    await fs.writeFile(dest, text);
    this.log.info({ dest, text }, 'summary delivered locally');
    return { ok: true, mode: 'link', detail: dest };
  }
}

export function safeName(title: string, ext: string): string {
  const base = title
    .normalize('NFKC')
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N} _-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'clip'}.${ext}`;
}

export interface DeliveryRouterOptions {
  telegramBotToken?: string;
  googleServiceAccountJson?: string;
  discordMaxUploadMb: number;
  telegramMaxUploadMb: number;
  localDir: string;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export class DeliveryRouter {
  private discord: DiscordDeliverer;
  private telegram: TelegramDeliverer | null;
  private drive: DriveDeliverer | null;
  private local: LocalDeliverer;

  constructor(o: DeliveryRouterOptions) {
    this.discord = new DiscordDeliverer(o.discordMaxUploadMb, o.fetchImpl);
    this.telegram = o.telegramBotToken ? new TelegramDeliverer(o.telegramBotToken, o.telegramMaxUploadMb, o.fetchImpl) : null;
    this.drive = o.googleServiceAccountJson ? new DriveDeliverer(o.googleServiceAccountJson, o.fetchImpl) : null;
    this.local = new LocalDeliverer(o.localDir, o.log);
  }

  for(target: DeliveryTarget): { deliverer: Deliverer; target: string } {
    switch (target.type) {
      case 'discord':
        return { deliverer: this.discord, target: target.target };
      case 'telegram':
        if (!this.telegram) throw new Error('telegram delivery needs TELEGRAM_BOT_TOKEN');
        return { deliverer: this.telegram, target: target.target };
      case 'drive':
        if (!this.drive) throw new Error('drive delivery needs GOOGLE_SERVICE_ACCOUNT_JSON');
        return { deliverer: this.drive, target: target.target };
      default:
        return { deliverer: this.local, target: '' };
    }
  }
}
