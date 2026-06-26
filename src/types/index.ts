export type AdminRole =
  | 'super_admin'
  | 'admin'
  | 'content_manager'
  | 'booking_manager'
  | 'finance_manager'
  | 'editor'
  | 'viewer';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: AdminRole;
  name: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
      // AI advisor abuse-protection context (CGNAT-aware, §6).
      aiSessionId?: string;
      aiIpHash?: string;
      aiTurnstileVerified?: boolean;
      // Trip portal: booking id from the verified magic-link session cookie.
      tripBookingId?: string;
    }
  }
}
