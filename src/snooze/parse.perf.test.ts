import { expect, it, vi } from 'vitest';
import { medianMs } from '../test/perf';
import { parseSnooze } from './parse';

const phrases = [
  '3h',
  '2d',
  '1w',
  '1mo',
  '5',
  'in 3 hours',
  'in 45 minutes',
  'in 2 days',
  '1d',
  'later',
  'later today',
  'tomorrow',
  'tomorrow 3pm',
  'tomorrow at 14:00',
  'tomorrow 14',
  'today 16:00',
  'today 9am',
  'this weekend',
  'next week',
  'next month',
  'fri',
  'monday',
  'next mon',
  'mon 9am',
  'thurs 17:30',
  '9am',
  '16:00',
  'noon',
  '12am',
  'oct 20',
  '20 oct',
  'october 20 2pm',
  '2026-10-20',
  '2026-10-20 18:15',
  'oct 20 2027',
  'oct 10',
  '2025-01-01',
  'feb 30',
  'blah',
  '13pm',
  '25:00',
  '',
];

it('parses within the per-call budget', () => {
  vi.useRealTimers();
  const now = new Date(2026, 9, 16, 14, 30);
  const perCall = medianMs(() => phrases.forEach((p) => parseSnooze(p, now))) / phrases.length;
  console.info(`parseSnooze median per call: ${perCall.toFixed(4)} ms`);
  expect(perCall).toBeLessThanOrEqual(0.2);
});
