import os from 'node:os';
import BigNumber from 'bignumber.js';
import { supabase } from '../config/supabase';
import { env } from '../config/env';
import {
  BASE_CURRENCY,
  CURRENCY_SETTINGS_KEY,
  type CurrencyConfig,
  EXCHANGE_RATE_PROVIDER,
  enabledCurrencyCodes,
  getCurrencyConfig,
  isSupportedCurrencyCode,
  normalizeCurrencyConfigList,
  supportedCurrencies,
  validateCurrencyConfigList
} from '../config/currencies';

type SnapshotRow = {
  id: string;
  provider: string;
  base_currency: string;
  rates: Record<string, number | string> | null;
  provider_timestamp: string | null;
  fetched_at: string;
  expires_at: string | null;
  created_at: string;
  status: 'success' | 'failed';
  error_code?: string | null;
  error_message?: string | null;
};

type RatesMap = Record<string, string>;

type LatestRatesState = {
  provider: typeof EXCHANGE_RATE_PROVIDER;
  baseCurrency: typeof BASE_CURRENCY;
  supportedCurrencies: Array<ReturnType<typeof publicCurrency>>;
  rates: RatesMap;
  lastUpdated: string | null;
  providerTimestamp: string | null;
  expiresAt: string | null;
  isStale: boolean;
  status: 'success' | 'stale' | 'missing';
  markupPercent: number;
};

type RefreshResult = {
  refreshed: boolean;
  reason?: 'locked' | 'missing_app_id' | 'provider_error';
  errorCode?: string;
  errorMessage?: string;
  latest: LatestRatesState;
};

class ExchangeRateError extends Error {
  code: string;
  transient: boolean;

  constructor(code: string, message: string, transient = false) {
    super(message);
    this.code = code;
    this.transient = transient;
  }
}

const SNAPSHOT_SELECT =
  'id,provider,base_currency,rates,provider_timestamp,fetched_at,expires_at,created_at,status,error_code,error_message';

const publicCurrency = (currency: CurrencyConfig, rates: RatesMap = {}) => ({
  code: currency.code,
  name: currency.name,
  symbol: currency.symbol,
  locale: currency.locale,
  decimalDigits: currency.decimalDigits,
  enabled: currency.enabled,
  available: currency.code === BASE_CURRENCY || Boolean(rates[currency.code])
});

const toRatesMap = (rates: Record<string, number | string> | null | undefined, currencies: CurrencyConfig[]): RatesMap => {
  const next: RatesMap = {};
  for (const currency of currencies) {
    const raw = rates?.[currency.code];
    if (raw === undefined || raw === null) continue;
    const value = new BigNumber(raw);
    if (value.isFinite() && value.gt(0)) next[currency.code] = value.toString();
  }
  if (!next[BASE_CURRENCY]) next[BASE_CURRENCY] = '1';
  return next;
};

const readConfiguredCurrencies = async (): Promise<CurrencyConfig[]> => {
  try {
    const { data, error } = await supabase
      .from('website_settings')
      .select('setting_value')
      .eq('setting_key', CURRENCY_SETTINGS_KEY)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !data) return normalizeCurrencyConfigList(null);
    return validateCurrencyConfigList((data as { setting_value?: unknown }).setting_value);
  } catch {
    return normalizeCurrencyConfigList(null);
  }
};

export const convertUsdAmountForDisplay = (
  amountUsd: string | number | BigNumber,
  rate: string | number | BigNumber,
  decimalDigits: number,
  markupPercent = 0
) => {
  const amount = new BigNumber(amountUsd);
  const providerRate = new BigNumber(rate);
  const markupMultiplier = new BigNumber(1).plus(new BigNumber(markupPercent).div(100));
  if (!amount.isFinite() || !providerRate.isFinite() || !providerRate.gt(0)) {
    throw new ExchangeRateError('invalid_conversion_input', 'Invalid amount or exchange rate.');
  }
  return amount.times(providerRate).times(markupMultiplier).decimalPlaces(decimalDigits, BigNumber.ROUND_HALF_UP).toString();
};

export const formatCurrencyAmount = (amount: string | number | BigNumber, currencyCode: string, currencies: CurrencyConfig[] = supportedCurrencies) => {
  const config = getCurrencyConfig(currencyCode, currencies) ?? getCurrencyConfig(BASE_CURRENCY, currencies)!;
  const value = new BigNumber(amount);
  const rounded = value.decimalPlaces(config.decimalDigits, BigNumber.ROUND_HALF_UP).toNumber();
  return new Intl.NumberFormat(config.locale, {
    style: 'currency',
    currency: config.code,
    minimumFractionDigits: config.decimalDigits,
    maximumFractionDigits: config.decimalDigits
  }).format(rounded);
};

export const validateOpenExchangeRatesPayload = (payload: unknown, currencies: CurrencyConfig[] = supportedCurrencies): { rates: RatesMap; providerTimestamp: string } => {
  if (!payload || typeof payload !== 'object') {
    throw new ExchangeRateError('invalid_json', 'Open Exchange Rates returned invalid JSON.');
  }

  const record = payload as { base?: unknown; timestamp?: unknown; rates?: unknown };
  if (record.base !== BASE_CURRENCY) {
    throw new ExchangeRateError('invalid_base_currency', 'Open Exchange Rates response was not based on USD.');
  }

  const timestamp = Number(record.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new ExchangeRateError('invalid_timestamp', 'Open Exchange Rates returned an invalid timestamp.');
  }
  const providerDate = new Date(timestamp * 1000);
  if (Number.isNaN(providerDate.getTime())) {
    throw new ExchangeRateError('invalid_timestamp', 'Open Exchange Rates returned an invalid timestamp.');
  }

  if (!record.rates || typeof record.rates !== 'object') {
    throw new ExchangeRateError('missing_rates', 'Open Exchange Rates returned no rates object.');
  }

  const rawRates = record.rates as Record<string, unknown>;
  const rates: RatesMap = {};
  for (const code of enabledCurrencyCodes(currencies)) {
    if (!(code in rawRates)) throw new ExchangeRateError('missing_currency', `Missing ${code} exchange rate.`);
    const rate = new BigNumber(rawRates[code] as BigNumber.Value);
    if (!rate.isFinite() || !rate.gt(0)) throw new ExchangeRateError('invalid_rate', `Invalid ${code} exchange rate.`);
    if (code === BASE_CURRENCY && !rate.eq(1)) {
      throw new ExchangeRateError('invalid_usd_rate', 'USD exchange rate must equal 1.');
    }
    rates[code] = rate.toString();
  }

  return { rates, providerTimestamp: providerDate.toISOString() };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const safeErrorMessage = (error: unknown) => {
  if (error instanceof ExchangeRateError) return error.message;
  if (error instanceof Error) return error.message || 'Exchange-rate refresh failed.';
  return 'Exchange-rate refresh failed.';
};

const errorCode = (error: unknown) => (error instanceof ExchangeRateError ? error.code : 'exchange_rate_refresh_failed');

const isTransient = (error: unknown) => error instanceof ExchangeRateError && error.transient;

export const currencyService = {
  async getSupportedCurrencies() {
    return (await readConfiguredCurrencies()).map((currency) => ({ ...currency }));
  },

  isSupported(code: string) {
    return isSupportedCurrencyCode(code);
  },

  async isConfiguredSupported(code: string) {
    return isSupportedCurrencyCode(code, await readConfiguredCurrencies());
  },

  async getLatestRates(): Promise<LatestRatesState> {
    const currencies = await readConfiguredCurrencies();
    try {
      const { data, error } = await supabase
        .from('exchange_rate_snapshots')
        .select(SNAPSHOT_SELECT)
        .eq('provider', EXCHANGE_RATE_PROVIDER)
        .eq('base_currency', BASE_CURRENCY)
        .eq('status', 'success')
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) return this.usdOnlyState(currencies);

      const row = data as SnapshotRow;
      const rates = toRatesMap(row.rates, currencies);
      const expiresAt = row.expires_at;
      const isStale = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
      return {
        provider: EXCHANGE_RATE_PROVIDER,
        baseCurrency: BASE_CURRENCY,
        supportedCurrencies: currencies.map((currency) => publicCurrency(currency, rates)),
        rates,
        lastUpdated: row.fetched_at,
        providerTimestamp: row.provider_timestamp,
        expiresAt,
        isStale,
        status: isStale ? 'stale' : 'success',
        markupPercent: env.EXCHANGE_RATE_MARKUP_PERCENT
      };
    } catch {
      return this.usdOnlyState(currencies);
    }
  },

  usdOnlyState(currencies: CurrencyConfig[] = supportedCurrencies): LatestRatesState {
    const rates = { [BASE_CURRENCY]: '1' };
    return {
      provider: EXCHANGE_RATE_PROVIDER,
      baseCurrency: BASE_CURRENCY,
      supportedCurrencies: currencies.map((currency) => publicCurrency(currency, rates)),
      rates,
      lastUpdated: null,
      providerTimestamp: null,
      expiresAt: null,
      isStale: true,
      status: 'missing',
      markupPercent: env.EXCHANGE_RATE_MARKUP_PERCENT
    };
  },

  async getLastError() {
    try {
      const { data } = await supabase
        .from('exchange_rate_snapshots')
        .select('status,error_code,error_message,fetched_at,created_at')
        .eq('provider', EXCHANGE_RATE_PROVIDER)
        .eq('base_currency', BASE_CURRENCY)
        .eq('status', 'failed')
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return null;
      const row = data as Pick<SnapshotRow, 'error_code' | 'error_message' | 'fetched_at' | 'created_at'>;
      return {
        code: row.error_code ?? 'exchange_rate_refresh_failed',
        message: row.error_message ?? 'Exchange-rate refresh failed.',
        at: row.fetched_at ?? row.created_at
      };
    } catch {
      return null;
    }
  },

  getRate(code: string, rates: RatesMap) {
    const normalized = code.toUpperCase();
    const raw = rates[normalized];
    if (!raw) return null;
    const rate = new BigNumber(raw);
    return rate.isFinite() && rate.gt(0) ? rate : null;
  },

  convert(amountUsd: string | number, targetCurrency: string, rates: RatesMap, currencies: CurrencyConfig[] = supportedCurrencies) {
    const normalized = targetCurrency.toUpperCase();
    const config = getCurrencyConfig(normalized, currencies);
    const rate = this.getRate(normalized, rates);
    if (!config || !rate) throw new ExchangeRateError('unsupported_currency', 'Unsupported or unavailable currency.');
    return convertUsdAmountForDisplay(amountUsd, rate, config.decimalDigits, env.EXCHANGE_RATE_MARKUP_PERCENT);
  },

  format(amountUsd: string | number, targetCurrency: string, rates: RatesMap, currencies: CurrencyConfig[] = supportedCurrencies) {
    const converted = this.convert(amountUsd, targetCurrency, rates, currencies);
    return formatCurrencyAmount(converted, targetCurrency, currencies);
  },

  async refreshRates(source: 'scheduler' | 'manual' = 'scheduler', userId?: string): Promise<RefreshResult> {
    if (!env.OPEN_EXCHANGE_RATES_APP_ID) {
      await this.recordFailure('missing_app_id', 'Open Exchange Rates App ID is not configured.', userId);
      return {
        refreshed: false,
        reason: 'missing_app_id',
        errorCode: 'missing_app_id',
        errorMessage: 'Open Exchange Rates App ID is not configured.',
        latest: await this.getLatestRates()
      };
    }

    const owner = `${os.hostname()}:${process.pid}:${Date.now()}`;
    let locked = false;
    try {
      locked = await this.acquireRefreshLock(owner);
    } catch (error) {
      return {
        refreshed: false,
        reason: 'provider_error',
        errorCode: errorCode(error),
        errorMessage: safeErrorMessage(error),
        latest: await this.getLatestRates()
      };
    }
    if (!locked) {
      return { refreshed: false, reason: 'locked', latest: await this.getLatestRates() };
    }

    try {
      const currencies = await readConfiguredCurrencies();
      const payload = await this.fetchProviderWithRetry(currencies);
      const { rates, providerTimestamp } = validateOpenExchangeRatesPayload(payload, currencies);
      const fetchedAt = new Date();
      const expiresAt = new Date(fetchedAt.getTime() + env.EXCHANGE_RATE_CACHE_HOURS * 60 * 60 * 1000);

      const { error } = await supabase.from('exchange_rate_snapshots').insert({
        provider: EXCHANGE_RATE_PROVIDER,
        base_currency: BASE_CURRENCY,
        rates,
        provider_timestamp: providerTimestamp,
        fetched_at: fetchedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        status: 'success',
        metadata: { source },
        created_by: userId ?? null
      });
      if (error) throw new ExchangeRateError('database_error', 'Unable to store exchange-rate snapshot.');

      return { refreshed: true, latest: await this.getLatestRates() };
    } catch (error) {
      await this.recordFailure(errorCode(error), safeErrorMessage(error), userId);
      return {
        refreshed: false,
        reason: 'provider_error',
        errorCode: errorCode(error),
        errorMessage: safeErrorMessage(error),
        latest: await this.getLatestRates()
      };
    } finally {
      await this.releaseRefreshLock(owner);
    }
  },

  async fetchProviderWithRetry(currencies: CurrencyConfig[]) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.fetchProvider(currencies);
      } catch (error) {
        if (attempt === maxAttempts || !isTransient(error)) throw error;
        await delay(400 * attempt);
      }
    }
    throw new ExchangeRateError('provider_unavailable', 'Open Exchange Rates is unavailable.', true);
  },

  async fetchProvider(currencies: CurrencyConfig[]) {
    const appId = env.OPEN_EXCHANGE_RATES_APP_ID;
    if (!appId) throw new ExchangeRateError('missing_app_id', 'Open Exchange Rates App ID is not configured.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.EXCHANGE_RATE_REQUEST_TIMEOUT_MS);
    try {
      const url = new URL('https://openexchangerates.org/api/latest.json');
      url.searchParams.set('app_id', appId);
      url.searchParams.set('symbols', enabledCurrencyCodes(currencies).join(','));
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const code = response.status === 401 ? 'provider_unauthorized' : response.status === 429 ? 'provider_rate_limited' : 'provider_http_error';
        throw new ExchangeRateError(code, `Open Exchange Rates returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
      }
      return await response.json().catch(() => {
        throw new ExchangeRateError('invalid_json', 'Open Exchange Rates returned invalid JSON.');
      });
    } catch (error) {
      if (error instanceof ExchangeRateError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ExchangeRateError('provider_timeout', 'Open Exchange Rates request timed out.', true);
      }
      throw new ExchangeRateError('provider_network_error', 'Unable to reach Open Exchange Rates.', true);
    } finally {
      clearTimeout(timeout);
    }
  },

  async acquireRefreshLock(owner: string) {
    const { data, error } = await supabase.rpc('exchange_rates_try_lock', {
      p_lock_key: `${EXCHANGE_RATE_PROVIDER}:latest`,
      p_owner: owner,
      p_ttl_seconds: env.EXCHANGE_RATE_LOCK_TTL_SECONDS
    });
    if (error) throw new ExchangeRateError('lock_error', 'Unable to acquire exchange-rate refresh lock.');
    return data === true;
  },

  async releaseRefreshLock(owner: string) {
    await supabase.rpc('exchange_rates_release_lock', {
      p_lock_key: `${EXCHANGE_RATE_PROVIDER}:latest`,
      p_owner: owner
    });
  },

  async recordFailure(code: string, message: string, userId?: string) {
    try {
      await supabase.from('exchange_rate_snapshots').insert({
        provider: EXCHANGE_RATE_PROVIDER,
        base_currency: BASE_CURRENCY,
        rates: null,
        fetched_at: new Date().toISOString(),
        expires_at: null,
        status: 'failed',
        error_code: code,
        error_message: message,
        metadata: {},
        created_by: userId ?? null
      });
    } catch {
      // Keep serving the previous snapshot even if failure logging itself fails.
    }
  }
};
