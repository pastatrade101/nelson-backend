import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

const SETTING_KEY = 'branding';

export const getBranding = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('website_settings')
    .select('setting_value')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch branding.', 500, [error]);
  return sendSuccess(res, 'Branding fetched successfully.', data?.setting_value ?? {});
});

export const updateBranding = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('website_settings')
    .select('*')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle();

  const { data, error } = await supabase
    .from('website_settings')
    .upsert(
      {
        setting_key: SETTING_KEY,
        setting_value: req.body,
        description: 'Public branding configuration (identity, colors, contact).',
        is_public: true
      },
      { onConflict: 'setting_key' }
    )
    .select('*')
    .single();

  if (error) throw new AppError('Unable to update branding.', 500, [error]);

  await safeAudit({ action: 'update', entityId: data?.id, entityType: 'website_settings', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Branding updated successfully.', data.setting_value);
});
