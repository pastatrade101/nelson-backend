import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { generateBookingCode } from '../services/booking-code.service';
import { syncBookingToMakutano } from '../services/makutano-connect.service';
import { sendBookingNotification, syncBookingToHubSpot } from '../services/notification.service';
import { currencyService } from '../services/currency.service';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { cleanSearch, getPagination, getQueryString, paginationMeta } from '../utils/query';
import { softDeleteRecord } from '../utils/supabase-helpers';

const listSelect = '*, tours(title,slug)';
const detailSelect =
  '*, tours(id,title,slug,price_from,currency,main_image_url,duration_days,destinations(name,slug))';

const PUBLIC_SOURCES = ['website_booking_form', 'plan_my_trip', 'begin_your_journey', 'email_itinerary'];

const nullifyEmpties = (input: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = value === '' ? null : value;
  }
  return out;
};

export const createBooking = asyncHandler(async (req, res) => {
  const payload = nullifyEmpties(req.body as Record<string, unknown>);
  const isAdmin = Boolean(req.user);

  // ── Anti-spam: honeypot ────────────────────────────────────────────────────
  // The hidden `hp_company` field is invisible to real users; bots tend to fill
  // every field. If it's set, pretend success and store nothing. (Drop it either
  // way so it never reaches the insert.)
  const honeypot = String(payload.hp_company ?? '').trim();
  delete payload.hp_company;
  if (!isAdmin && honeypot) {
    return sendSuccess(res, 'Booking request submitted successfully.', { booking_code: null }, 201);
  }

  let source = String(payload.source ?? 'website_booking_form');
  // Public submitters may only set public sources — never forge admin/CRM sources.
  if (!isAdmin && !PUBLIC_SOURCES.includes(source)) source = 'website_booking_form';

  // ── Idempotency ─────────────────────────────────────────────────────────────
  // Preferred path: the form sends a stable idempotency_key, and the unique
  // index on that column is what actually enforces uniqueness — including
  // against two requests racing in parallel, which no read-then-write check can
  // catch. The insert below turns the resulting 23505 into the existing row.
  const idempotencyKey = String(payload.idempotency_key ?? '').trim();
  if (!idempotencyKey) delete payload.idempotency_key;
  if (!isAdmin && idempotencyKey) {
    const { data: existing } = await supabase
      .from('booking_requests')
      .select(detailSelect)
      .eq('idempotency_key', idempotencyKey)
      .is('deleted_at', null)
      .maybeSingle();
    if (existing) return sendSuccess(res, 'Booking request already received.', existing, 201);
  }

  // ── Anti-spam: duplicate guard ──────────────────────────────────────────────
  // Fallback for forms that send no key. Protects against double-taps / refresh
  // re-posts: the same email, for the same trip, from the same form, inside two
  // minutes returns the existing request instead of creating a duplicate row.
  // Scoping by SOURCE matters: the contextual forms all leave tour_id null, so
  // without it a plan-my-trip request and a tour-page email capture from the
  // same person collapse into each other and the visitor is handed back somebody
  // else's request.
  if (!isAdmin && !idempotencyKey) {
    const email = String(payload.email ?? '').trim();
    if (email) {
      const sinceIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      let dupQuery = supabase
        .from('booking_requests')
        .select(detailSelect)
        .ilike('email', email)
        .eq('source', source)
        .gte('created_at', sinceIso)
        .is('deleted_at', null);
      dupQuery = payload.tour_id
        ? dupQuery.eq('tour_id', payload.tour_id as string)
        : dupQuery.is('tour_id', null);

      const { data: existing } = await dupQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        return sendSuccess(res, 'Booking request already received.', existing, 201);
      }
    }
  }

  // The currency the visitor was actually looking at when they enquired, so the
  // specialist quotes in the same one. Validated against the configured list —
  // an unsupported code falls back to USD rather than being trusted.
  const selectedCurrencyInput = String(payload.selected_currency ?? payload.currency ?? 'USD').trim().toUpperCase();
  const selectedCurrency = (await currencyService.isConfiguredSupported(selectedCurrencyInput))
    ? selectedCurrencyInput
    : 'USD';
  delete payload.selected_currency;
  const leadContext = (payload.lead_context as Record<string, unknown> | null) ?? {};
  if (!isAdmin) leadContext.selected_currency = selectedCurrency;

  const bookingCode = await generateBookingCode();

  const insertData = {
    ...payload,
    booking_code: bookingCode,
    status: 'pending',
    payment_status: 'unpaid',
    source,
    lead_context: leadContext
  };

  const { data, error } = await supabase
    .from('booking_requests')
    .insert(insertData)
    .select(detailSelect)
    .single();

  if (error) {
    // 23505 = unique violation on idempotency_key: two submissions raced, and
    // this one lost. The winner is the real record, so hand that back rather
    // than showing the visitor an error for a request that did go through.
    if (error.code === '23505' && idempotencyKey) {
      const { data: winner } = await supabase
        .from('booking_requests')
        .select(detailSelect)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (winner) return sendSuccess(res, 'Booking request already received.', winner, 201);
    }
    throw new AppError('Unable to submit booking request.', 500, [error]);
  }

  // Fire-and-forget side effects — must never block or fail booking creation.
  void sendBookingNotification(data as Record<string, unknown>);
  void syncBookingToHubSpot(data as Record<string, unknown>);
  // Dual-write to Makutano Connect — the WhatsApp/booking infrastructure this site is
  // a tenant of. Same fire-and-forget rule as the HubSpot sync: the traveller's
  // enquiry is already stored locally and must never fail on an infrastructure hop.
  void syncBookingToMakutano(data as Record<string, unknown>);

  if (isAdmin) {
    await safeAudit({ action: 'create', entityId: (data as { id?: string })?.id, entityType: 'booking_requests', newData: data, req });
  }

  return sendSuccess(res, 'Booking request submitted successfully.', data, 201);
});

export const listBookings = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const search = cleanSearch(getQueryString(req.query, 'search'));

  let query = supabase
    .from('booking_requests')
    .select(listSelect, { count: 'exact' })
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(
      ['booking_code', 'full_name', 'email', 'phone', 'country', 'message']
        .map((column) => `${column}.ilike.%${search}%`)
        .join(',')
    );
  }

  for (const column of ['status', 'payment_status', 'tour_id', 'assigned_to', 'source']) {
    const value = getQueryString(req.query, column);
    if (value && value !== 'all') query = query.eq(column, value);
  }

  const createdFrom = getQueryString(req.query, 'created_from');
  const createdTo = getQueryString(req.query, 'created_to');
  if (createdFrom) query = query.gte('created_at', createdFrom);
  if (createdTo) query = query.lte('created_at', `${createdTo}T23:59:59`);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch bookings.', 500, [error]);

  return sendSuccess(res, 'Bookings fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

const fetchBookingWithSummary = async (column: 'booking_code' | 'id', value: string) => {
  const { data, error } = await supabase
    .from('booking_requests')
    .select(detailSelect)
    .eq(column, value)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch booking.', 500, [error]);
  if (!data) throw new AppError('Booking not found.', 404);

  const record = data as Record<string, unknown>;
  let paymentSummary = { total_paid: 0, payments_count: 0, currency: String(record.currency ?? 'USD') };

  try {
    const { data: payments } = await supabase
      .from('booking_payments')
      .select('amount,status,currency')
      .eq('booking_id', String(record.id))
      .is('deleted_at', null);

    if (payments && payments.length > 0) {
      const paid = payments.filter((p) => p.status === 'paid');
      paymentSummary = {
        total_paid: paid.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
        payments_count: payments.length,
        currency: String(payments[0]?.currency ?? paymentSummary.currency)
      };
    }
  } catch {
    // Payments are optional — never block booking detail on a payments error.
  }

  return { ...record, payment_summary: paymentSummary };
};

export const getBooking = asyncHandler(async (req, res) => {
  const data = await fetchBookingWithSummary('id', req.params.id);
  return sendSuccess(res, 'Booking fetched successfully.', data);
});

export const getBookingByCode = asyncHandler(async (req, res) => {
  const data = await fetchBookingWithSummary('booking_code', req.params.bookingCode);
  return sendSuccess(res, 'Booking fetched successfully.', data);
});

export const updateBooking = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase.from('booking_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Booking not found.', 404);

  const payload = nullifyEmpties(req.body as Record<string, unknown>);
  const { data, error } = await supabase
    .from('booking_requests')
    .update(payload)
    .eq('id', req.params.id)
    .select(detailSelect)
    .single();

  if (error) throw new AppError('Unable to update booking.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'booking_requests', oldData: previous, newData: data, req });
  return sendSuccess(res, 'Booking updated successfully.', data);
});

export const updateBookingStatus = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase.from('booking_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Booking not found.', 404);

  const update: Record<string, unknown> = { status: req.body.status };
  if (req.body.admin_notes !== undefined && req.body.admin_notes !== null) update.admin_notes = req.body.admin_notes;

  const { data, error } = await supabase
    .from('booking_requests')
    .update(update)
    .eq('id', req.params.id)
    .select(detailSelect)
    .single();

  if (error) throw new AppError('Unable to update booking status.', 500, [error]);

  await safeAudit({ action: 'status_change', entityId: req.params.id, entityType: 'booking_requests', oldData: previous, newData: data, req });
  return sendSuccess(res, 'Booking status updated successfully.', data);
});

export const assignBooking = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase.from('booking_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Booking not found.', 404);

  const { data, error } = await supabase
    .from('booking_requests')
    .update({ assigned_to: req.body.assigned_to || null })
    .eq('id', req.params.id)
    .select(detailSelect)
    .single();

  if (error) throw new AppError('Unable to assign booking.', 500, [error]);

  await safeAudit({ action: 'assign', entityId: req.params.id, entityType: 'booking_requests', oldData: previous, newData: data, req });
  return sendSuccess(res, 'Booking assigned successfully.', data);
});

export const updateBookingNotes = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase.from('booking_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Booking not found.', 404);

  const { data, error } = await supabase
    .from('booking_requests')
    .update({ admin_notes: req.body.admin_notes ?? null })
    .eq('id', req.params.id)
    .select(detailSelect)
    .single();

  if (error) throw new AppError('Unable to update booking notes.', 500, [error]);

  await safeAudit({ action: 'notes_update', entityId: req.params.id, entityType: 'booking_requests', oldData: previous, newData: data, req });
  return sendSuccess(res, 'Booking notes updated successfully.', data);
});

export const deleteBooking = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'booking_requests', req.params.id, req);
});
