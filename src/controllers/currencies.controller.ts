import { getNextExchangeRateRefresh } from '../services/exchange-rate-scheduler.service';
import { currencyService } from '../services/currency.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

export const getCurrencies = asyncHandler(async (_req, res) => {
  const latest = await currencyService.getLatestRates();
  return sendSuccess(res, 'Currencies fetched successfully.', {
    ...latest,
    nextRefresh: getNextExchangeRateRefresh()
  });
});
