import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { env } from './env';

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Supabase credentials are not configured. API calls that require the database will fail.');
}

// supabase-js initialises a Realtime client in its constructor, which on
// Node < 22 (e.g. the Node 18 production box) throws without a native WebSocket.
// We don't use Realtime, but we must satisfy the constructor — so provide `ws`.
// (Long term: run Node 20+, which has native WebSocket and drops the deprecation.)
const options = {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket }
} as unknown as Parameters<typeof createClient>[2];

export const supabase = createClient(
  env.SUPABASE_URL || 'http://localhost:54321',
  env.SUPABASE_SERVICE_ROLE_KEY || 'development-service-role-key',
  options
);
