import pino, { type Logger } from 'pino';

export type { Logger };

let root: Logger | null = null;

export function getLogger(name?: string): Logger {
  if (!root) {
    const pretty = process.env.LOG_PRETTY === '1' || (process.stdout.isTTY && process.env.NODE_ENV !== 'production');
    root = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      base: { host: process.env.WORKER_HOST_ID },
      redact: {
        paths: ['*.apiKey', '*.token', '*.refreshToken', '*.accessToken', 'headers.authorization'],
        censor: '[redacted]',
      },
      ...(pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
        : {}),
    });
  }
  return name ? root.child({ mod: name }) : root;
}
