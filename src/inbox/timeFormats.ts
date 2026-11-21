import { parseMtime } from './derive';

export const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export const MOMENT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const WAKE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const NO_WAKE_DATE = 'no wake date';

export function formatted(format: Intl.DateTimeFormat, iso: string): string {
  const ms = parseMtime(iso);
  return Number.isNaN(ms) ? iso : format.format(ms);
}
