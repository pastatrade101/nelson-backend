import { z } from 'zod';

const hexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{6})$/, 'Use a 6-digit hex color like #1f4d3a.');

const optionalText = z.string().optional().nullable();

export const brandingColorsSchema = z
  .object({
    deep_green: hexColor,
    forest: hexColor,
    goldfinch_gold: hexColor,
    savanna: hexColor,
    sand: hexColor,
    ink: hexColor,
    clay: hexColor
  })
  .partial();

export const brandingSchema = z.object({
  site_name: optionalText,
  tagline: optionalText,
  positioning: optionalText,
  company_name: optionalText,
  ai_advisor_name: optionalText,
  logo_url: optionalText,
  favicon_url: optionalText,
  primary_cta: optionalText,
  secondary_cta: optionalText,
  whatsapp_cta: optionalText,
  support_email: optionalText,
  support_phone: optionalText,
  colors: brandingColorsSchema.optional()
});
