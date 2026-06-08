import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { createRecord, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';
import { getQueryString } from '../utils/query';

export const getHomepage = asyncHandler(async (req, res) => {
  const includeInactive = getQueryString(req.query, 'all') === 'true';

  let query = supabase
    .from('homepage_sections')
    .select('*')
    .is('deleted_at', null)
    .order('sort_order', { ascending: true });

  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to fetch homepage content.', 500, [error]);
  return sendSuccess(res, 'Homepage content fetched successfully.', data ?? []);
});

export const updateHomepage = asyncHandler(async (req, res) => {
  type HomepageSectionInput = {
    section_key: string;
    title?: string | null;
    subtitle?: string | null;
    content?: string | null;
    image_url?: string | null;
    button_text?: string | null;
    button_url?: string | null;
    extra_data?: unknown;
    is_active?: boolean;
    sort_order?: number;
  };

  const sections = Array.isArray(req.body.sections) ? (req.body.sections as HomepageSectionInput[]) : [];

  if (sections.length === 0) {
    throw new AppError('At least one homepage section is required.', 422);
  }

  const payload = sections.map((section) => ({
    section_key: section.section_key,
    title: section.title ?? null,
    subtitle: section.subtitle ?? null,
    content: section.content ?? null,
    image_url: section.image_url ?? null,
    button_text: section.button_text ?? null,
    button_url: section.button_url ?? null,
    extra_data: section.extra_data ?? {},
    is_active: section.is_active ?? true,
    sort_order: section.sort_order ?? 0
  }));

  const { data, error } = await supabase
    .from('homepage_sections')
    .upsert(payload, { onConflict: 'section_key' })
    .select('*');

  if (error) throw new AppError('Unable to update homepage content.', 500, [error]);
  return sendSuccess(res, 'Homepage content updated successfully.', data);
});

export const createHomepageSection = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'homepage_sections', req.body);
});

export const updateHomepageSection = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'homepage_sections', req.params.id, req.body);
});

export const deleteHomepageSection = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'homepage_sections', req.params.id, req);
});
