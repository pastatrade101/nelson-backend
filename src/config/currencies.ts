export const EXCHANGE_RATE_PROVIDER = 'open_exchange_rates';
export const BASE_CURRENCY = 'USD';
export const CURRENCY_SETTINGS_KEY = 'supported_currencies';

export type CurrencyConfig = {
  code: string;
  name: string;
  symbol: string;
  locale: string;
  decimalDigits: number;
  enabled: boolean;
};

export const defaultSupportedCurrencies: CurrencyConfig[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', locale: 'en-US', decimalDigits: 2, enabled: true },
  { code: 'EUR', name: 'Euro', symbol: '€', locale: 'de-DE', decimalDigits: 2, enabled: true },
  { code: 'GBP', name: 'British Pound', symbol: '£', locale: 'en-GB', decimalDigits: 2, enabled: true },
  { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh', locale: 'sw-TZ', decimalDigits: 0, enabled: true },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', locale: 'en-KE', decimalDigits: 0, enabled: true },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', locale: 'en-ZA', decimalDigits: 2, enabled: true },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', locale: 'en-AU', decimalDigits: 2, enabled: true },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', locale: 'en-CA', decimalDigits: 2, enabled: true }
];

export const supportedCurrencies = defaultSupportedCurrencies;

const CODE = /^[A-Z]{3}$/;

export const normalizeCurrencyCode = (value: string) => String(value ?? '').trim().toUpperCase();

export const normalizeCurrencyConfigList = (value: unknown): CurrencyConfig[] => {
  if (!Array.isArray(value)) return defaultSupportedCurrencies.map((currency) => ({ ...currency }));

  const seen = new Set<string>();
  const next: CurrencyConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<CurrencyConfig>;
    const code = normalizeCurrencyCode(record.code ?? '');
    if (!CODE.test(code) || seen.has(code)) continue;

    const decimalDigits = Number(record.decimalDigits);
    const currency: CurrencyConfig = {
      code,
      name: String(record.name ?? code).trim() || code,
      symbol: String(record.symbol ?? code).trim() || code,
      locale: String(record.locale ?? 'en-US').trim() || 'en-US',
      decimalDigits: Number.isInteger(decimalDigits) && decimalDigits >= 0 && decimalDigits <= 4 ? decimalDigits : 2,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true
    };
    seen.add(code);
    next.push(currency);
  }

  if (!next.some((currency) => currency.code === BASE_CURRENCY)) next.unshift({ ...defaultSupportedCurrencies[0] });
  return next.map((currency) => (currency.code === BASE_CURRENCY ? { ...currency, enabled: true, decimalDigits: 2 } : currency));
};

export const validateCurrencyConfigList = (value: unknown): CurrencyConfig[] => {
  if (!Array.isArray(value)) throw new Error('Supported currencies must be a JSON array.');

  const seen = new Set<string>();
  const next: CurrencyConfig[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`Currency row ${index + 1} must be an object.`);
    const record = item as Partial<CurrencyConfig>;
    const code = normalizeCurrencyCode(record.code ?? '');
    if (!CODE.test(code)) throw new Error(`Currency row ${index + 1} must use a valid 3-letter ISO currency code.`);
    if (seen.has(code)) throw new Error(`${code} is duplicated in supported currencies.`);

    const name = String(record.name ?? '').trim();
    const symbol = String(record.symbol ?? '').trim();
    const locale = String(record.locale ?? '').trim();
    const decimalDigits = Number(record.decimalDigits);

    if (!name) throw new Error(`${code} must have a currency name.`);
    if (!symbol) throw new Error(`${code} must have a display symbol.`);
    if (!locale) throw new Error(`${code} must have an Intl locale, for example en-US.`);
    if (!Number.isInteger(decimalDigits) || decimalDigits < 0 || decimalDigits > 4) {
      throw new Error(`${code} decimal digits must be a whole number from 0 to 4.`);
    }
    if (typeof record.enabled !== 'boolean') throw new Error(`${code} enabled must be true or false.`);

    try {
      new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(1);
    } catch {
      throw new Error(`${code} locale/currency combination is not supported by Intl.NumberFormat.`);
    }

    seen.add(code);
    next.push({ code, name, symbol, locale, decimalDigits, enabled: record.enabled });
  }

  const usd = next.find((currency) => currency.code === BASE_CURRENCY);
  if (!usd) throw new Error('USD must remain in supported currencies because all package prices are stored in USD.');
  if (!usd.enabled) throw new Error('USD must remain enabled.');
  if (usd.decimalDigits !== 2) throw new Error('USD must use 2 decimal digits.');

  return next;
};

export const supportedCurrencyCodes = (currencies: CurrencyConfig[] = defaultSupportedCurrencies) =>
  currencies.map((currency) => currency.code);

export const enabledCurrencyCodes = (currencies: CurrencyConfig[] = defaultSupportedCurrencies) =>
  currencies.filter((currency) => currency.enabled).map((currency) => currency.code);

export const isSupportedCurrencyCode = (value: string, currencies: CurrencyConfig[] = defaultSupportedCurrencies) =>
  supportedCurrencyCodes(currencies).includes(normalizeCurrencyCode(value));

export const getCurrencyConfig = (code: string, currencies: CurrencyConfig[] = defaultSupportedCurrencies) =>
  currencies.find((currency) => currency.code === normalizeCurrencyCode(code));
