/**
 * Operator alerts (quota thresholds, cost caps, ingest failures).
 * Sent to an ops Discord webhook and/or Telegram chat, deduped per key/day.
 */
import type { Logger } from './log';

export interface OpsAlerter {
  alert(key: string, message: string, opts?: { level?: 'info' | 'warn' | 'error'; dedupe?: boolean }): Promise<void>;
}

export class DefaultOpsAlerter implements OpsAlerter {
  private sent = new Map<string, number>();

  constructor(
    private opts: {
      log: Logger;
      discordWebhookUrl?: string;
      telegramBotToken?: string;
      telegramChatId?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async alert(key: string, message: string, { level = 'warn', dedupe = true } = {}) {
    const day = new Date().toISOString().slice(0, 10);
    const dk = `${day}:${key}`;
    if (dedupe && this.sent.has(dk)) return;
    this.sent.set(dk, Date.now());
    const log = this.opts.log;
    (level === 'error' ? log.error : level === 'info' ? log.info : log.warn).call(log, { alert: key }, message);
    const f = this.opts.fetchImpl ?? fetch;
    const text = `[inbetween ${level}] ${message}`;
    const tasks: Promise<unknown>[] = [];
    if (this.opts.discordWebhookUrl) {
      tasks.push(
        f(this.opts.discordWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text.slice(0, 1900) }),
        }),
      );
    }
    if (this.opts.telegramBotToken && this.opts.telegramChatId) {
      tasks.push(
        f(`https://api.telegram.org/bot${this.opts.telegramBotToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.opts.telegramChatId, text }),
        }),
      );
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') this.opts.log.error({ err: r.reason }, 'ops alert send failed');
  }
}
