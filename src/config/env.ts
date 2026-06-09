import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('')),
  SUPABASE_STORAGE_BUCKET: z.string().default('goldfinch-media'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters long').default('development-only-change-this-secret'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal('')),
  HUBSPOT_ACCESS_TOKEN: z.string().optional().or(z.literal('')),
  HUBSPOT_PORTAL_ID: z.string().optional().or(z.literal(''))
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const messages = parsed.error.errors.map((error) => `${error.path.join('.')}: ${error.message}`);
  throw new Error(`Invalid environment configuration: ${messages.join(', ')}`);
}

if (parsed.data.NODE_ENV === 'production') {
  if (!parsed.data.SUPABASE_URL || !parsed.data.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.');
  }

  if (parsed.data.JWT_SECRET === 'development-only-change-this-secret') {
    throw new Error('JWT_SECRET must be changed in production.');
  }
}

export const env = parsed.data;
// Comma-separated list of allowed front-end origins for CORS. Trailing slashes are
// stripped so e.g. "https://goldfinch.makutano.co.tz/" matches the browser's origin.
export const allowedOrigins = env.FRONTEND_URL.split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
