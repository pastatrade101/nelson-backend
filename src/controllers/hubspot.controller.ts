import { syncToHubSpot } from '../services/hubspot.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

export const syncLead = asyncHandler(async (req, res) => {
  const data = await syncToHubSpot('lead', req.body);
  return sendSuccess(res, 'Lead sync processed.', data);
});

export const syncBooking = asyncHandler(async (req, res) => {
  const data = await syncToHubSpot('booking', req.body);
  return sendSuccess(res, 'Booking sync processed.', data);
});
