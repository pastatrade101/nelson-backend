import { supabase } from '../config/supabase';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { createTripLink, redeemGuestToken } from '../services/trip-portal.service';
import { deleteGuestDocument, signGuestDocument, storeGuestDocument } from '../services/guest-documents.service';

/**
 * Guest information for a confirmed booking.
 *
 * The office issues a private link; the guest opens it and fills in passport and
 * traveller details for everyone travelling. Two audiences, deliberately kept
 * apart:
 *
 *   GUEST  — reaches exactly one submission, and only by presenting a valid,
 *            unexpired, unrevoked token of purpose 'guest_details'. Never sees a
 *            booking id, never sees another booking, and once the office locks
 *            the submission can only read it.
 *   OFFICE — authenticated, behind guest_details.view / guest_details.manage.
 *
 * Passport numbers and dates of birth are returned to the guest (they are
 * editing their own data) but passport FILES are never returned to anyone as a
 * URL — see guest-documents.service.ts.
 */

type Row = Record<string, unknown>;

const text = (v: unknown, max = 400): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};
/** '' is what an empty date input submits; Postgres rejects it. */
const date = (v: unknown): string | null => text(v, 40);

/** Resolve a raw token to its submission, creating the shell row on first open. */
const submissionForToken = async (rawToken: string) => {
  const target = await redeemGuestToken(rawToken);
  if (!target) throw new AppError('This link is no longer valid. Please ask us for a new one.', 404);

  // A standalone form's token points straight at its submission.
  if (target.submissionId) {
    const { data, error } = await supabase
      .from('guest_detail_submissions')
      .select('*')
      .eq('id', target.submissionId)
      .maybeSingle();
    if (error) throw new AppError('Unable to load this form.', 500, [error]);
    if (!data) throw new AppError('This form is no longer available.', 404);
    return data as Row;
  }

  const bookingId = target.bookingId as string;
  const { data: existing, error } = await supabase
    .from('guest_detail_submissions')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle();
  if (error) throw new AppError('Unable to load this form.', 500, [error]);
  if (existing) return existing as Row;

  // First open: seed from the booking so the guest is not retyping what we know.
  const { data: booking } = await supabase
    .from('booking_requests')
    .select('booking_code, email, travel_date')
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle();

  const { data: created, error: insertError } = await supabase
    .from('guest_detail_submissions')
    .insert({
      booking_id: bookingId,
      booking_reference: (booking as Row)?.booking_code ?? null,
      lead_email: (booking as Row)?.email ?? null,
      arrival_date: (booking as Row)?.travel_date ?? null
    })
    .select('*')
    .single();
  if (insertError) throw new AppError('Unable to start this form.', 500, [insertError]);
  return created as Row;
};

/**
 * The hero image shown at the top of the guest form, set once in
 * Settings → Booking. Read server-side rather than from the public settings
 * endpoint, because the setting is not public — only a token holder sees it.
 */
const heroImageUrl = async (): Promise<string | null> => {
  const { data } = await supabase
    .from('website_settings')
    .select('setting_value')
    .eq('setting_key', 'guest_form_hero_image_url')
    .is('deleted_at', null)
    .maybeSingle();
  const value = (data as Row)?.setting_value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Everything the guest's own form needs. Excludes ids and office-only fields. */
const guestView = async (submission: Row) => {
  const { data: travellers } = await supabase
    .from('guest_details')
    .select('id, full_name, nationality, date_of_birth, gender, passport_number, passport_country, passport_expiry, passport_copy_path, dietary, medical, notes, sort_order')
    .eq('submission_id', submission.id as string)
    .order('sort_order');

  return {
    hero_image_url: await heroImageUrl(),
    booking_reference: submission.booking_reference ?? null,
    lead_email: submission.lead_email ?? null,
    arrival_date: submission.arrival_date ?? null,
    departure_date: submission.departure_date ?? null,
    arrival_flight: submission.arrival_flight ?? null,
    departure_flight: submission.departure_flight ?? null,
    emergency_name: submission.emergency_name ?? null,
    emergency_relationship: submission.emergency_relationship ?? null,
    emergency_phone: submission.emergency_phone ?? null,
    emergency_email: submission.emergency_email ?? null,
    consent_given: submission.consent_given === true,
    submitted_at: submission.submitted_at ?? null,
    // The guest is told it is locked so the form can explain itself, rather
    // than silently rejecting their save.
    locked: Boolean(submission.locked_at),
    travellers: (travellers ?? []).map((t) => {
      const row = t as Row;
      return {
        ...row,
        // Whether a file exists, never where it is.
        has_passport_copy: Boolean(row.passport_copy_path),
        passport_copy_path: undefined
      };
    })
  };
};

// ── Guest ─────────────────────────────────────────────────────────────────

export const getGuestForm = asyncHandler(async (req, res) => {
  const submission = await submissionForToken(req.params.token);
  return sendSuccess(res, 'Form loaded.', await guestView(submission));
});

export const saveGuestForm = asyncHandler(async (req, res) => {
  const submission = await submissionForToken(req.params.token);
  if (submission.locked_at) {
    throw new AppError('These details have been confirmed and can no longer be edited. Please contact us with any changes.', 409);
  }

  const body = req.body as Row;

  const { error: updateError } = await supabase
    .from('guest_detail_submissions')
    .update({
      booking_reference: text(body.booking_reference, 60),
      lead_email: text(body.lead_email, 200),
      arrival_date: date(body.arrival_date),
      departure_date: date(body.departure_date),
      arrival_flight: text(body.arrival_flight),
      departure_flight: text(body.departure_flight),
      emergency_name: text(body.emergency_name, 200),
      emergency_relationship: text(body.emergency_relationship, 120),
      emergency_phone: text(body.emergency_phone, 60),
      emergency_email: text(body.emergency_email, 200),
      consent_given: body.consent_given === true,
      submitted_at: new Date().toISOString()
    })
    .eq('id', submission.id as string);
  if (updateError) throw new AppError('Unable to save your details.', 500, [updateError]);

  // Travellers are replaced wholesale, matching how the form edits them. Files
  // are preserved by carrying the existing path forward for rows the form sends
  // back with a keep flag, so re-saving the form does not orphan an upload.
  const incoming = Array.isArray(body.travellers) ? (body.travellers as Row[]) : [];

  const { data: current } = await supabase
    .from('guest_details')
    .select('id, passport_copy_path')
    .eq('submission_id', submission.id as string);
  const pathById = new Map((current ?? []).map((r) => [String((r as Row).id), (r as Row).passport_copy_path as string | null]));

  await supabase.from('guest_details').delete().eq('submission_id', submission.id as string);

  const rows = incoming
    .filter((t) => text(t.full_name, 200))
    .map((t, i) => ({
      submission_id: submission.id as string,
      full_name: text(t.full_name, 200) ?? '',
      nationality: text(t.nationality, 120),
      date_of_birth: date(t.date_of_birth),
      gender: text(t.gender, 30),
      passport_number: text(t.passport_number, 60)?.toUpperCase() ?? null,
      passport_country: text(t.passport_country, 120),
      passport_expiry: date(t.passport_expiry),
      // Keep a previously uploaded file attached to this traveller.
      passport_copy_path: t.id ? (pathById.get(String(t.id)) ?? null) : null,
      dietary: text(t.dietary, 2000),
      medical: text(t.medical, 2000),
      notes: text(t.notes, 2000),
      sort_order: i
    }));

  if (rows.length) {
    const { error: insertError } = await supabase.from('guest_details').insert(rows);
    if (insertError) throw new AppError('Unable to save traveller details.', 500, [insertError]);
  }

  // Any file whose traveller row is gone is now unreachable — remove it rather
  // than leave passport scans lying in storage.
  const kept = new Set(rows.map((r) => r.passport_copy_path).filter(Boolean) as string[]);
  for (const [, path] of pathById) {
    if (path && !kept.has(path)) await deleteGuestDocument(path);
  }

  const { data: refreshed } = await supabase
    .from('guest_detail_submissions').select('*').eq('id', submission.id as string).maybeSingle();
  return sendSuccess(res, 'Thank you — your details have been received.', await guestView((refreshed ?? submission) as Row));
});

/** Guest uploads one passport copy against one traveller on their own form. */
export const uploadGuestDocument = asyncHandler(async (req, res) => {
  const submission = await submissionForToken(req.params.token);
  if (submission.locked_at) throw new AppError('These details have been confirmed and can no longer be edited.', 409);
  if (!req.file) throw new AppError('No file was received.', 400);

  const travellerId = text(req.body?.traveller_id, 60);
  if (!travellerId) throw new AppError('Please save the traveller before attaching a passport copy.', 400);

  // The traveller must belong to THIS submission — otherwise a valid token
  // could attach a file to someone else's booking.
  const { data: traveller } = await supabase
    .from('guest_details')
    .select('id, passport_copy_path')
    .eq('id', travellerId)
    .eq('submission_id', submission.id as string)
    .maybeSingle();
  if (!traveller) throw new AppError('That traveller is not part of this booking.', 404);

  const stored = await storeGuestDocument(submission.id as string, req.file);

  const previous = (traveller as Row).passport_copy_path as string | null;
  const { error } = await supabase
    .from('guest_details')
    .update({ passport_copy_path: stored.path })
    .eq('id', travellerId);
  if (error) throw new AppError('Unable to attach the passport copy.', 500, [error]);
  if (previous) await deleteGuestDocument(previous);

  return sendSuccess(res, 'Passport copy received.', { has_passport_copy: true });
});

// ── Office ────────────────────────────────────────────────────────────────

/** Issue (or reissue) the private link for a booking-backed form. */
export const createGuestLink = asyncHandler(async (req, res) => {
  const { url, expiresAt } = await createTripLink(req.params.id, req.user?.sub ?? null, 'guest_details');
  return sendSuccess(res, 'Guest link created.', { url, expiresAt });
});

/**
 * Create a form that has no booking behind it, and hand back its link in one
 * step — the office usually needs passport details before a booking row exists.
 */
export const createStandaloneForm = asyncHandler(async (req, res) => {
  const label = text(req.body?.label, 160);
  if (!label) throw new AppError('Please give this form a name so you can find it later.', 422);

  const { data: created, error } = await supabase
    .from('guest_detail_submissions')
    .insert({
      label,
      lead_email: text(req.body?.lead_email, 200),
      booking_reference: text(req.body?.booking_reference, 60)
    })
    .select('*')
    .single();
  if (error) throw new AppError('Unable to create the form.', 500, [error]);

  const { url, expiresAt } = await createTripLink(null, req.user?.sub ?? null, 'guest_details', created.id as string);
  return sendSuccess(res, 'Guest form created.', { submission: created, url, expiresAt }, 201);
});

/** Every form the office holds, newest first, for the Guest forms screen. */
export const listGuestForms = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('guest_detail_submissions')
    .select('*, booking_requests(booking_code, full_name, email)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new AppError('Unable to load guest forms.', 500, [error]);

  // Traveller counts, so the list can show progress at a glance.
  const ids = (data ?? []).map((r) => (r as Row).id as string);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: rows } = await supabase.from('guest_details').select('submission_id').in('submission_id', ids);
    for (const r of rows ?? []) {
      const key = (r as Row).submission_id as string;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return sendSuccess(res, 'Guest forms fetched.', {
    items: (data ?? []).map((r) => ({ ...(r as Row), traveller_count: counts.get((r as Row).id as string) ?? 0 }))
  });
});

/** Issue (or reissue) the link for a standalone form, by submission id. */
export const createStandaloneLink = asyncHandler(async (req, res) => {
  const { url, expiresAt } = await createTripLink(null, req.user?.sub ?? null, 'guest_details', req.params.submissionId);
  return sendSuccess(res, 'Guest link created.', { url, expiresAt });
});

/** Read one form by its own id, for the Guest forms screen. */
export const getGuestForm_admin = asyncHandler(async (req, res) => {
  const { data: submission } = await supabase
    .from('guest_detail_submissions')
    .select('*, booking_requests(booking_code, full_name, email)')
    .eq('id', req.params.submissionId)
    .maybeSingle();
  if (!submission) throw new AppError('Form not found.', 404);

  const { data: travellers } = await supabase
    .from('guest_details').select('*').eq('submission_id', req.params.submissionId).order('sort_order');

  return sendSuccess(res, 'Guest form fetched.', {
    submission,
    travellers: (travellers ?? []).map((t) => ({ ...(t as Row), has_passport_copy: Boolean((t as Row).passport_copy_path) }))
  });
});

/** Lock/unlock a standalone form by submission id. */
export const setStandaloneLock = asyncHandler(async (req, res) => {
  const lock = req.body?.locked !== false;
  const { error } = await supabase
    .from('guest_detail_submissions')
    .update({ locked_at: lock ? new Date().toISOString() : null, locked_by: lock ? req.user?.sub ?? null : null })
    .eq('id', req.params.submissionId);
  if (error) throw new AppError('Unable to update the lock.', 500, [error]);
  return sendSuccess(res, lock ? 'Form locked.' : 'Form unlocked.', { locked: lock });
});

/** Revoke the active link without touching the data already collected. */
export const revokeGuestLink = asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from('trip_access_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('booking_id', req.params.id)
    .eq('purpose', 'guest_details')
    .is('revoked_at', null);
  if (error) throw new AppError('Unable to revoke the link.', 500, [error]);
  return sendSuccess(res, 'Guest link revoked.', { revoked: true });
});

export const getBookingGuestDetails = asyncHandler(async (req, res) => {
  const { data: submission } = await supabase
    .from('guest_detail_submissions')
    .select('*')
    .eq('booking_id', req.params.id)
    .maybeSingle();
  if (!submission) return sendSuccess(res, 'No guest details yet.', { submission: null, travellers: [] });

  const { data: travellers } = await supabase
    .from('guest_details')
    .select('*')
    .eq('submission_id', (submission as Row).id as string)
    .order('sort_order');

  return sendSuccess(res, 'Guest details fetched.', {
    submission,
    travellers: (travellers ?? []).map((t) => ({
      ...(t as Row),
      has_passport_copy: Boolean((t as Row).passport_copy_path)
    }))
  });
});

/** Mint a short-lived URL so the office can open one passport copy. */
export const getGuestDocumentUrl = asyncHandler(async (req, res) => {
  const { data: traveller } = await supabase
    .from('guest_details')
    .select('passport_copy_path')
    .eq('id', req.params.travellerId)
    .maybeSingle();
  const path = (traveller as Row)?.passport_copy_path as string | undefined;
  if (!path) throw new AppError('No passport copy on file for that traveller.', 404);
  return sendSuccess(res, 'Document link created.', { url: await signGuestDocument(path), expiresInSeconds: 120 });
});

/** Freeze the submission once permits and tickets have been issued. */
export const setGuestDetailsLock = asyncHandler(async (req, res) => {
  const lock = req.body?.locked !== false;
  const { error } = await supabase
    .from('guest_detail_submissions')
    .update({
      locked_at: lock ? new Date().toISOString() : null,
      locked_by: lock ? req.user?.sub ?? null : null
    })
    .eq('booking_id', req.params.id);
  if (error) throw new AppError('Unable to update the lock.', 500, [error]);
  return sendSuccess(res, lock ? 'Guest details locked.' : 'Guest details unlocked.', { locked: lock });
});
