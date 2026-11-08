/**
 * Netscape cookies.txt support. Datacenter IPs often hit YouTube's
 * "Sign in to confirm you're not a bot" wall; a cookies file exported from a
 * logged-in browser session (a dedicated ops account) lets streamlink/yt-dlp through.
 */
import fs from 'node:fs/promises';

export interface Cookie {
  domain: string;
  name: string;
  value: string;
}

export function parseCookiesTxt(text: string): Cookie[] {
  const out: Cookie[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    out.push({ domain: parts[0], name: parts[5], value: parts[6] });
  }
  return out;
}

const cache = new Map<string, { at: number; cookies: Cookie[] }>();

export async function readYouTubeCookies(file: string): Promise<Cookie[]> {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.at < 60_000) return hit.cookies;
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const cookies = parseCookiesTxt(text).filter((c) => /(^|\.)youtube\.com$/.test(c.domain.replace(/^\./, '')) || c.domain.endsWith('youtube.com'));
  cache.set(file, { at: Date.now(), cookies });
  return cookies;
}

export async function cookieHeaderFromFile(file: string): Promise<string> {
  const cookies = await readYouTubeCookies(file);
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** streamlink takes cookies as repeated `--http-cookie NAME=VALUE` args. */
export function streamlinkCookieArgs(cookies: Cookie[]): string[] {
  return cookies.flatMap((c) => ['--http-cookie', `${c.name}=${c.value}`]);
}
