import 'server-only';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3: S3Client | null = null;

/** URL for a stored object: R2 public domain, R2 presigned URL, or the worker's /files (dev). */
export async function mediaUrl(key: string, expiresS = 3600): Promise<string | null> {
  if (!key) return null;
  const pub = process.env.R2_PUBLIC_BASE_URL ?? process.env.LOCAL_STORAGE_PUBLIC_URL;
  const hasR2 = process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY;
  if (process.env.R2_PUBLIC_BASE_URL || (!hasR2 && pub)) return `${pub!.replace(/\/$/, '')}/${key}`;
  if (!hasR2) return null;
  s3 ??= new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT ?? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }), { expiresIn: expiresS });
}
