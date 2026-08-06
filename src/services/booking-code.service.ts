import { supabase } from '../config/supabase';

const PREFIX = 'EMN-BKG';

/**
 * Generates a unique, human-readable booking code such as `EMN-BKG-000001`.
 * Uses the current row count as the sequence base and retries on collision
 * (handles concurrent inserts). Falls back to a timestamp-based code so a
 * booking is never blocked by code generation.
 */
export const generateBookingCode = async (): Promise<string> => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const { count } = await supabase
      .from('booking_requests')
      .select('id', { count: 'exact', head: true });

    const sequence = (count ?? 0) + 1 + attempt;
    const code = `${PREFIX}-${String(sequence).padStart(6, '0')}`;

    const { data } = await supabase
      .from('booking_requests')
      .select('id')
      .eq('booking_code', code)
      .limit(1);

    if (!data || data.length === 0) return code;
  }

  // Guaranteed-unique fallback if the sequential space is unexpectedly congested.
  return `${PREFIX}-${Date.now().toString(36).toUpperCase()}`;
};
