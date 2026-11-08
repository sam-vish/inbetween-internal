/**
 * Small crypto helpers: OAuth token encryption at rest, viewer author hashing,
 * and signed (tamper-proof) onboarding links.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function keyFrom(secret: string): Buffer {
  // Accept a 32-byte key as hex/base64, otherwise derive one with SHA-256.
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  const b64 = Buffer.from(secret, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(secret)) return b64;
  return createHash('sha256').update(secret).digest();
}

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). */
export function encryptSecret(plaintext: string, secret: string): string {
  const key = keyFrom(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decryptSecret(payload: string, secret: string): string {
  const key = keyFrom(secret);
  const buf = Buffer.from(payload, 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Viewer privacy: never store raw viewer channel IDs, only salted hashes. */
export function hashAuthor(authorId: string, salt: string): string {
  return createHmac('sha256', salt).update(authorId).digest('base64url').slice(0, 22);
}

export function signPayload(data: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof data.exp === 'number' && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
