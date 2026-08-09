import { env } from '../config/env';
import { currencyService } from './currency.service';

type ParsedCron = {
  minutes: number[];
  hours: number[];
};

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSlot = '';

const parseField = (field: string, min: number, max: number) => {
  if (field === '*') return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let value = start; value <= end; value += 1) if (value >= min && value <= max) values.add(value);
      continue;
    }
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= min && value <= max) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
};

export const parseExchangeRateCron = (cron = env.EXCHANGE_RATE_REFRESH_CRON): ParsedCron => {
  const [minute = '0', hour = '6,18'] = cron.trim().split(/\s+/);
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  if (!minutes.length || !hours.length) return { minutes: [0], hours: [6, 18] };
  return { minutes, hours };
};

const zonedParts = (date: Date, timeZone = env.EXCHANGE_RATE_TIMEZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute')
  };
};

const scheduleSlot = (date: Date) => {
  const schedule = parseExchangeRateCron();
  const parts = zonedParts(date);
  if (!schedule.hours.includes(parts.hour) || !schedule.minutes.includes(parts.minute)) return '';
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
};

export const getNextExchangeRateRefresh = (from = new Date()) => {
  const schedule = parseExchangeRateCron();
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  for (let offset = 0; offset < 60 * 24 * 8; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60000);
    const parts = zonedParts(candidate);
    if (schedule.hours.includes(parts.hour) && schedule.minutes.includes(parts.minute)) return candidate.toISOString();
  }
  return null;
};

const tick = async () => {
  if (running) return;
  const slot = scheduleSlot(new Date());
  if (!slot || slot === lastSlot) return;
  lastSlot = slot;
  running = true;
  try {
    const result = await currencyService.refreshRates('scheduler');
    if (!result.refreshed && result.reason !== 'locked') {
      console.warn(`Exchange-rate scheduled refresh skipped: ${result.errorCode ?? result.reason ?? 'unknown'}`);
    }
  } catch (error) {
    console.error('Exchange-rate scheduler failed.', error);
  } finally {
    running = false;
  }
};

export const startExchangeRateScheduler = () => {
  if (!env.EXCHANGE_RATE_REFRESH_ENABLED || timer) return;
  timer = setInterval(() => {
    void tick();
  }, 30 * 1000);
  void tick();
  // Cold start: if there's no successful snapshot yet, fetch once now so the site
  // isn't stuck USD-only until the first scheduled slot (06:00/18:00 by default).
  void (async () => {
    try {
      const latest = await currencyService.getLatestRates();
      if (latest.status === 'missing') await currencyService.refreshRates('scheduler');
    } catch {
      // Non-fatal — the interval tick will retry at the next scheduled slot.
    }
  })();
  console.log(`Exchange-rate scheduler enabled: ${env.EXCHANGE_RATE_REFRESH_CRON} (${env.EXCHANGE_RATE_TIMEZONE})`);
};

export const stopExchangeRateScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
