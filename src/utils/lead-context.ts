/** A lossless, readable brief for email/CRM: never stringify objects as [object Object]. */
export const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export function leadContextLines(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.length ? value.flatMap((item, i) => leadContextLines(item, `${path} · ${i + 1}`)) : [`${path}: None selected`];
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => key !== 'submission_fingerprint').flatMap(([key, item]) => leadContextLines(item, path ? `${path} / ${label(key)}` : label(key)));
  return [`${path}: ${value == null ? 'Not specified' : value === '' ? 'Not provided' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}`];
}
