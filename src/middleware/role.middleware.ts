import type { NextFunction, Request, Response } from 'express';
import type { AdminRole } from '../types';
import { AppError } from '../utils/api-response';

export const authorizeRoles = (...roles: AdminRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('Authentication is required.', 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403));
    }

    return next();
  };
};

export const adminOrEditor = authorizeRoles('super_admin', 'admin', 'content_manager', 'booking_manager', 'finance_manager', 'editor');
export const adminOnly = authorizeRoles('super_admin', 'admin');
export const superAdminOnly = authorizeRoles('super_admin');
