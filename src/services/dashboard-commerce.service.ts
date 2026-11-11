import { supabase } from '../config/supabase';

/**
 * The commercial half of the CMS overview: is money owed to us, is anyone
 * waiting on us, where do the quotations stand, and did our messages arrive.
 *
 * Read only from Emnel's own tables (booking_requests, booking_payments,
 * quotations, notification_events). Nothing is estimated or projected: a figure
 * is either derived from a record that exists or it is zero/absent.
 */

type Row = Record<string, unknown>;

const rows = async <T extends Row = Row>(table: string, select: string, build?: (q: any) => any): Promise<T[]> => {
  try {
    let query = supabase.from(table).select(select);
    if (build) query = build(query);
    const { data, error } = await query;
    if (error) return [];
    return (data ?? []) as unknown as T[];
  } catch {
    return [];
  }
};

const num = (value: unknown) => Number(value ?? 0) || 0;
const dayKey = (value: unknown) => String(value ?? '').slice(0, 10);

/** UTC midnight, `back` days ago. The series is a calendar, not a rolling window. */
const dayStart = (back: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - back);
  return d;
};

/** Emnel's quotation stages, in the order a quotation moves through them. */
export const QUOTATION_STAGES = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'] as const;

export const commerceSnapshot = async (days = 30) => {
  const since = dayStart(days - 1).toISOString();

  const [payments, bookings, quotations, notifications] = await Promise.all([
    rows<{ amount: unknown; status: unknown; currency: unknown; paid_at: unknown; created_at: unknown }>(
      'booking_payments',
      'amount, status, currency, paid_at, created_at',
      (q) => q.is('deleted_at', null).limit(5000)
    ),
    rows<{ status: unknown; payment_status: unknown; estimated_amount: unknown; currency: unknown; created_at: unknown }>(
      'booking_requests',
      'status, payment_status, estimated_amount, currency, created_at',
      (q) => q.is('deleted_at', null).limit(5000)
    ),
    rows<{ status: unknown; total_amount: unknown; currency: unknown; accepted_at: unknown }>(
      'quotations',
      'status, total_amount, currency, accepted_at',
      (q) => q.is('deleted_at', null).limit(5000)
    ),
    rows<{ status: unknown; channel: unknown; detail: unknown }>('notification_events', 'status, channel, detail', (q) =>
      q.gte('created_at', since).limit(2000)
    )
  ]);

  // ── Money, per currency (never summed across currencies) ────────────────
  const money: Record<string, { received: number; refunded: number; outstanding: number }> = {};
  const bump = (code: string) => (money[code] ??= { received: 0, refunded: 0, outstanding: 0 });

  for (const p of payments) {
    const code = String(p.currency ?? 'USD');
    if (p.status === 'paid') bump(code).received += num(p.amount);
    if (p.status === 'refunded') bump(code).refunded += num(p.amount);
  }

  // What confirmed trips still owe. Unconfirmed enquiries owe nothing yet.
  let unpaidConfirmed = 0;
  let pendingEnquiries = 0;
  for (const b of bookings) {
    if (b.status === 'pending') pendingEnquiries += 1;
    if (b.status !== 'confirmed' || b.payment_status === 'paid') continue;
    unpaidConfirmed += 1;
    if (b.estimated_amount != null) bump(String(b.currency ?? 'USD')).outstanding += num(b.estimated_amount);
  }

  // ── Daily series ─────────────────────────────────────────────────────────
  const series: Array<{ date: string; received: number; enquiries: number; accepted: number }> = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayStart(i).toISOString().slice(0, 10);
    index.set(key, series.length);
    series.push({ date: key, received: 0, enquiries: 0, accepted: 0 });
  }
  const add = (key: string, field: 'received' | 'enquiries' | 'accepted', by: number) => {
    const at = index.get(key);
    if (at !== undefined) series[at][field] += by;
  };
  for (const p of payments) if (p.status === 'paid') add(dayKey(p.paid_at ?? p.created_at), 'received', num(p.amount));
  for (const b of bookings) add(dayKey(b.created_at), 'enquiries', 1);
  for (const q of quotations) if (q.accepted_at) add(dayKey(q.accepted_at), 'accepted', 1);

  // ── Quotation pipeline ──────────────────────────────────────────────────
  const pipeline: Record<string, number> = Object.fromEntries(QUOTATION_STAGES.map((s) => [s, 0]));
  let quotedValue = 0;
  let acceptedValue = 0;
  for (const q of quotations) {
    const status = String(q.status ?? 'draft');
    if (status in pipeline) pipeline[status] += 1;
    if (status === 'sent' || status === 'viewed') quotedValue += num(q.total_amount);
    if (status === 'accepted') acceptedValue += num(q.total_amount);
  }
  // Of the quotations that reached a decision, how many said yes. Undecided
  // ones are left out — a quote sent yesterday is not a refusal.
  const decided = pipeline.accepted + pipeline.declined + pipeline.expired;
  const winRate = decided > 0 ? Math.round((pipeline.accepted / decided) * 100) : null;

  // ── Work waiting on someone ──────────────────────────────────────────────
  const attention = {
    pendingEnquiries,
    quotationsToSend: pipeline.draft,
    unpaidConfirmed
  };

  // ── Did our messages land ───────────────────────────────────────────────
  // The recorded reason for every message that did not go out, so the page can
  // say why (e.g. "WhatsApp is not configured.") instead of guessing.
  const delivery = { sent: 0, skipped: 0, failed: 0 };
  const reasonCounts = new Map<string, { status: 'skipped' | 'failed'; channel: string; detail: string; count: number }>();
  for (const n of notifications) {
    const status = String(n.status ?? '');
    if (status === 'sent') delivery.sent += 1;
    else if (status === 'skipped' || status === 'failed') {
      delivery[status] += 1;
      const channel = String(n.channel ?? '');
      const detail = String(n.detail ?? '').trim() || 'No reason recorded.';
      const key = `${status}|${channel}|${detail}`;
      const hit = reasonCounts.get(key);
      if (hit) hit.count += 1;
      else reasonCounts.set(key, { status, channel, detail, count: 1 });
    }
  }
  const deliveryReasons = [...reasonCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    days,
    money,
    currencies: Object.keys(money).sort(),
    series,
    pipeline,
    quotedValue,
    acceptedValue,
    winRate,
    attention,
    delivery,
    deliveryReasons
  };
};
