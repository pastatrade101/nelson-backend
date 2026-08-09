import { env } from '../config/env';
import { getNextExchangeRateRefresh } from '../services/exchange-rate-scheduler.service';
import { currencyService } from '../services/currency.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

const monthlyRequestEstimate = () => {
  // Configured schedule is intended for two runs per day. Keep the estimate
  // explicit for admins instead of inferring provider usage from page traffic.
  return 60;
};

export const getExchangeRateStatus = asyncHandler(async (_req, res) => {
  const latest = await currencyService.getLatestRates();
  const lastError = await currencyService.getLastError();
  return sendSuccess(res, 'Exchange-rate status fetched successfully.', {
    ...latest,
    nextRefresh: getNextExchangeRateRefresh(),
    refreshEnabled: env.EXCHANGE_RATE_REFRESH_ENABLED,
    schedule: env.EXCHANGE_RATE_REFRESH_CRON,
    timezone: env.EXCHANGE_RATE_TIMEZONE,
    cacheHours: env.EXCHANGE_RATE_CACHE_HOURS,
    enabledCurrencies: latest.supportedCurrencies.filter((currency) => currency.enabled).map((currency) => currency.code),
    monthlyRequestEstimate: monthlyRequestEstimate(),
    lastError
  });
});

export const refreshExchangeRates = asyncHandler(async (req, res) => {
  const result = await currencyService.refreshRates('manual', req.user?.sub);
  return sendSuccess(
    res,
    result.refreshed ? 'Exchange rates refreshed successfully.' : 'Exchange-rate refresh did not replace the cached rates.',
    {
      ...result.latest,
      nextRefresh: getNextExchangeRateRefresh(),
      refreshed: result.refreshed,
      reason: result.reason,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      lastError: await currencyService.getLastError()
    }
  );
});
