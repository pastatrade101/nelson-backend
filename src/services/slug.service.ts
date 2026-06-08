import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';

export const createSlug = (value: string) => {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

export const createUniqueSlug = async (table: string, value: string, ignoreId?: string) => {
  const base = createSlug(value);
  let slug = base;
  let suffix = 1;

  while (suffix < 100) {
    let query = supabase.from(table).select('id').eq('slug', slug).limit(1);
    if (ignoreId) query = query.neq('id', ignoreId);

    const { data, error } = await query;
    if (error) throw new AppError(`Unable to verify slug for ${table}.`, 500, [error]);
    if (!data || data.length === 0) return slug;

    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  throw new AppError('Unable to generate a unique slug.', 500);
};
