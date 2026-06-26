import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../utils/api-response';
import { TRIP_COOKIE, verifyTripSession } from '../services/trip-portal.service';

const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};

/** Gate trip-portal endpoints on a valid, scope-checked session cookie. */
export const authenticateTrip = (req: Request, res: Response, next: NextFunction): void => {
  const bookingId = verifyTripSession(readCookie(req.headers.cookie, TRIP_COOKIE));
  if (!bookingId) {
    sendError(res, 'Your trip session has expired. Please open your trip link again.', [], 401);
    return;
  }
  req.tripBookingId = bookingId;
  next();
};
