import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env, r2Enabled } from '../config/env';

// Cloudflare R2 is S3-compatible. We talk to it with the AWS S3 SDK pointed at
// the account's R2 endpoint. R2 has NO egress fees, so serving media from here
// (behind the Cloudflare CDN custom domain) removes the Supabase egress ceiling.

let client: S3Client | null = null;

const getClient = (): S3Client => {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Guaranteed present whenever r2Enabled is true (the only path that calls this).
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? ''
      }
    });
  }
  return client;
};

// Public URL for an object, served via the Cloudflare CDN custom domain. The
// object key mirrors the Supabase Storage path (folder/uuid.ext), so URLs stay
// structurally identical apart from the host.
export const r2PublicUrl = (path: string): string => {
  const base = (env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const key = path.replace(/^\/+/, '');
  return `${base}/${key}`;
};

export const r2PutObject = async (path: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> => {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: path.replace(/^\/+/, ''),
      Body: body,
      ContentType: contentType,
      CacheControl: `public, max-age=${cacheControl}`
    })
  );
};

export const r2Remove = async (path: string): Promise<void> => {
  await getClient().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: path.replace(/^\/+/, '') }));
};

// Cheap existence check so the migration script can skip objects already copied.
export const r2ObjectExists = async (path: string): Promise<boolean> => {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: path.replace(/^\/+/, '') }));
    return true;
  } catch {
    return false;
  }
};

export { r2Enabled };
