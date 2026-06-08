import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';
import type { AuthTokenPayload } from '../types';

export const loginAdmin = async (email: string, password: string) => {
  const { data: user, error } = await supabase
    .from('admin_users')
    .select('id,email,password_hash,full_name,role,is_active')
    .eq('email', email.toLowerCase())
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new AppError('Unable to authenticate user.', 500, [error]);
  if (!user || !user.is_active) throw new AppError('Invalid email or password.', 401);

  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) throw new AppError('Invalid email or password.', 401);

  const payload: AuthTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.full_name
  };

  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });

  await supabase.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

  return {
    token,
    user: payload,
    expiresIn: env.JWT_EXPIRES_IN
  };
};
