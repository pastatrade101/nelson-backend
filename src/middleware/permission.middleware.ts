import type { NextFunction, Request, Response } from 'express';
import { rolePermissions, type PermissionKey } from '../config/permissions';
import { AppError } from '../utils/api-response';

export const requirePermission = (permission: PermissionKey) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError('Authentication is required.', 401));
    if (req.user.role === 'super_admin') return next();

    if (!rolePermissions[req.user.role]?.includes(permission)) {
      return next(new AppError('You do not have permission to perform this action.', 403));
    }

    return next();
  };
};

export const requireAnyPermission = (...permissions: PermissionKey[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError('Authentication is required.', 401));
    if (req.user.role === 'super_admin') return next();

    const allowed = permissions.some((permission) => rolePermissions[req.user!.role]?.includes(permission));
    if (!allowed) return next(new AppError('You do not have permission to perform this action.', 403));

    return next();
  };
};
