import type { CookieOptions } from 'express';
import { env } from '../config/env';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import {
  TRIP_COOKIE,
  createTripLink,
  getTripView,
  recordTripMessage,
  redeemTripToken,
  signTripSession
} from '../services/trip-portal.service';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  maxAge: 14 * 24 * 60 * 60 * 1000,
  path: '/'
});

/** Public: exchange a magic-link token for a session cookie + the trip view. */
export const exchangeTripToken = asyncHandler(async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const bookingId = await redeemTripToken(token);
  if (!bookingId) throw new AppError('This trip link is invalid or has expired.', 401);

  const view = await getTripView(bookingId);
  if (!view) throw new AppError('This trip is no longer available.', 404);

  res.cookie(TRIP_COOKIE, signTripSession(bookingId), cookieOptions());
  return sendSuccess(res, 'Trip access granted.', view);
});

/** Trip session: return the current booking's customer-safe view. */
export const getTrip = asyncHandler(async (req, res) => {
  const view = await getTripView(req.tripBookingId as string);
  if (!view) throw new AppError('This trip is no longer available.', 404);
  return sendSuccess(res, 'Trip loaded.', view);
});

/** Trip session: traveller sends a message to the specialist team. */
export const postTripMessage = asyncHandler(async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (message.length < 2) throw new AppError('Please write a short message.', 422);
  if (message.length > 4000) throw new AppError('Message is too long.', 422);

  await recordTripMessage(req.tripBookingId as string, message);
  return sendSuccess(res, "Message sent — we'll get back to you shortly.");
});

/** Trip session: end the session. */
export const logoutTrip = asyncHandler(async (_req, res) => {
  res.clearCookie(TRIP_COOKIE, { path: '/' });
  return sendSuccess(res, 'Signed out.');
});

/** Admin: generate (and copy) a fresh secure trip link for a booking. */
export const adminCreateTripLink = asyncHandler(async (req, res) => {
  const bookingId = typeof req.body?.booking_id === 'string' ? req.body.booking_id : '';
  if (!bookingId) throw new AppError('booking_id is required.', 422);

  const link = await createTripLink(bookingId, req.user?.sub ?? null);
  return sendSuccess(res, 'Trip link created.', link, 201);
});
