import { loginAdmin } from '../services/auth.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

export const login = asyncHandler(async (req, res) => {
  const result = await loginAdmin(req.body.email, req.body.password);
  return sendSuccess(res, 'Login successful.', result);
});

export const logout = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Logout successful.');
});

export const me = asyncHandler(async (req, res) => {
  return sendSuccess(res, 'Authenticated user fetched successfully.', req.user);
});
