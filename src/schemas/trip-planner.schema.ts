import { z } from 'zod';
const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export const tripPlannerAnswersSchema = z.object({
  experiences: z.array(z.string().min(1)).min(1), destinations: z.array(z.string()), party: z.string().min(1),
  adults: z.number().int().min(1).max(100), children: z.number().int().min(0).max(50),
  childAges: z.array(z.string().refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) <= 17), 'Child age must be 0–17 or unknown')),
  dateMode: z.enum(['exact', 'flexible', 'unsure']), startDate: z.string(), endDate: z.string(), month: z.string(), flexibility: z.string().min(1),
  duration: z.string().min(1), pace: z.string().min(1), comfort: z.string().min(1), accommodation: z.string(), priorities: z.array(z.string()),
  budget: z.string(), budgetUnsure: z.boolean(), stage: z.string().min(1), notes: z.string(), specialRequests: z.string(),
  fullName: z.string().trim().min(2), email: z.string().trim().email(), country: z.string().trim().min(1), phone: z.string(),
  preferredContact: z.enum(['Email', 'WhatsApp', 'Phone']), contactConsent: z.literal(true)
}).superRefine((d, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (d.childAges.length !== d.children) issue('childAges', 'Include one age or blank entry for each child.');
  if (d.dateMode === 'exact' && (!date(d.startDate) || !date(d.endDate) || d.endDate < d.startDate)) issue('startDate', 'Exact travel dates must be valid and in order.');
  if (d.dateMode === 'flexible' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(d.month)) issue('month', 'Choose a travel month and year.');
  if (!d.budgetUnsure && (!/^\d+(\.\d{1,2})?$/.test(d.budget) || Number(d.budget) <= 0 || Number(d.budget) > 1000000)) issue('budget', 'Provide a valid USD budget or mark it undecided.');
  if ((d.phone.trim() || d.preferredContact !== 'Email') && (!/^\+?[\d\s().-]{7,25}$/.test(d.phone.trim()) || d.phone.replace(/\D/g, '').length < 7)) issue('phone', 'Provide a phone number with country code.');
});
