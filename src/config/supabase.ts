import { createClient } from '@supabase/supabase-js';
import { env } from './env';

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Supabase credentials are not configured. API calls that require the database will fail.');
}

export const supabase = createClient(env.SUPABASE_URL || 'http://localhost:54321', env.SUPABASE_SERVICE_ROLE_KEY || 'development-service-role-key', {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
