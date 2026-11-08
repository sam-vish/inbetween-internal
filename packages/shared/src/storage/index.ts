/**
 * Object storage for clips, thumbnails and source clips.
 * R2 (S3-compatible) in production; a local directory in dev/replay.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env';

export interface ObjectStorage {
  readonly kind: 'r2' | 'local';
  put(key: string, filePath: string, contentType: string): Promise<void>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<void>;
  /** A URL a browser or delivery target can fetch. Signed when the bucket is private. */
  getUrl(key: string, expiresS?: number): Promise<string>;
  download(key: string, destPath: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  constructor(
    readonly root: string,
    readonly publicBaseUrl?: string,
  ) {}

  private p(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root))) throw new Error(`invalid key ${key}`);
    return full;
  }

  async put(key: string, filePath: string) {
    const dest = this.p(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(filePath, dest);
  }
  async putBuffer(key: string, data: Buffer) {
    const dest = this.p(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }
  async getUrl(key: string) {
    return this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, '')}/${key}` : `file://${this.p(key)}`;
  }
  async download(key: string, destPath: string) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(this.p(key), destPath);
  }
  async exists(key: string) {
    return fs
      .stat(this.p(key))
      .then(() => true)
      .catch(() => false);
  }
  async delete(key: string) {
    await fs.rm(this.p(key), { force: true });
  }
  /** Absolute path for a key (local only). */
  pathFor(key: string) {
    return this.p(key);
  }
}

export class R2Storage implements ObjectStorage {
  readonly kind = 'r2' as const;
  private s3: S3Client;

  constructor(
    private bucket: string,
    opts: { endpoint: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl?: string },
  ) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: opts.endpoint,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
    this.publicBaseUrl = opts.publicBaseUrl;
  }
  private publicBaseUrl?: string;

  async put(key: string, filePath: string, contentType: string) {
    const stat = await fs.stat(filePath);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: stat.size,
        ContentType: contentType,
      }),
    );
  }
  async putBuffer(key: string, data: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async getUrl(key: string, expiresS = 7 * 24 * 3600) {
    if (this.publicBaseUrl) return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: Math.min(expiresS, 7 * 24 * 3600),
    });
  }
  async download(key: string, destPath: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(res.Body as Readable, createWriteStream(destPath));
  }
  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createStorage(env: Env): ObjectStorage {
  const hasR2 = !!(env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && (env.R2_ACCOUNT_ID || env.R2_ENDPOINT));
  const driver = env.STORAGE_DRIVER ?? (hasR2 ? 'r2' : 'local');
  if (driver === 'r2') {
    if (!hasR2) throw new Error('STORAGE_DRIVER=r2 needs R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID');
    return new R2Storage(env.R2_BUCKET!, {
      endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    });
  }
  return new LocalStorage(path.resolve(env.DATA_DIR, 'storage'), env.LOCAL_STORAGE_PUBLIC_URL);
}

/** Canonical object keys, so every app agrees on layout. */
export const storageKeys = {
  fastClip: (clientId: string, momentId: string, version: number) => `clips/${clientId}/${momentId}/fast-v${version}.mp4`,
  thumb: (clientId: string, momentId: string, version: number) => `clips/${clientId}/${momentId}/thumb-v${version}.jpg`,
  source: (clientId: string, momentId: string) => `sources/${clientId}/${momentId}.ts`,
  premium: (clientId: string, momentId: string, version: number) => `clips/${clientId}/${momentId}/premium-v${version}.mp4`,
  compilation: (clientId: string, label: string) => `compilations/${clientId}/${label}.mp4`,
  liveFrame: (streamId: string) => `live/${streamId}/latest.jpg`,
};

export async function readStreamToBuffer(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(parts);
}
