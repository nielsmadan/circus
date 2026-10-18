import { describe, expect, it } from 'vitest';
import { formatSnoozeTime, parseSnooze, SNOOZE_PRESETS } from './parse';

type Parts = readonly [number, number, number, number, number];
const NOW = new Date(2026, 9, 16, 14, 30);
const parts = (d: Date): Parts => [
  d.getFullYear(),
  d.getMonth(),
  d.getDate(),
  d.getHours(),
  d.getMinutes(),
];
const at = (text: string, now: Date = NOW): Parts | string => {
  const r = parseSnooze(text, now);
  return r.ok ? parts(r.at) : r.error;
};
const PASSED = 'That time has already passed';
const UNRECOGNIZED = 'Try “3d”, “tomorrow 9am”, “fri”, “oct 20 14:00”';

it('runs in Europe/Berlin', () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin');
});

describe('parseSnooze', () => {
  it.each<[string, Parts]>([
    ['3h', [2026, 9, 16, 17, 30]],
    ['2d', [2026, 9, 18, 14, 30]],
    ['1w', [2026, 9, 23, 14, 30]],
    ['1mo', [2026, 10, 15, 14, 30]],
    ['5', [2026, 9, 21, 14, 30]],
    ['in 3 hours', [2026, 9, 16, 17, 30]],
    ['in 45 minutes', [2026, 9, 16, 15, 15]],
    ['in 2 days', [2026, 9, 18, 14, 30]],
    ['  IN  2   Days ', [2026, 9, 18, 14, 30]],
  ])('relative %s', (text, expected) => {
    expect(at(text)).toEqual(expected);
  });

  it('keeps local time across the autumn DST change', () => {
    const now = new Date(2026, 9, 24, 12, 0);
    const r = parseSnooze('1d', now);
    expect(r.ok && parts(r.at)).toEqual([2026, 9, 25, 12, 0]);
  });

  it.each<[string, Date, Parts | string]>([
    ['later today', NOW, [2026, 9, 16, 17, 30]],
    ['later', NOW, [2026, 9, 16, 17, 30]],
    ['later today', new Date(2026, 9, 16, 14, 40), [2026, 9, 16, 17, 45]],
    ['later today', new Date(2026, 9, 16, 21, 30), 'Too late for later today'],
  ])('%s at %s', (text, now, expected) => {
    expect(at(text, now)).toEqual(expected);
  });

  it.each<[string, Parts | string]>([
    ['tomorrow', [2026, 9, 17, 9, 0]],
    ['tomorrow 3pm', [2026, 9, 17, 15, 0]],
    ['tomorrow at 14:00', [2026, 9, 17, 14, 0]],
    ['tomorrow 14', [2026, 9, 17, 14, 0]],
    ['today 16:00', [2026, 9, 16, 16, 0]],
    ['today 9am', PASSED],
    ['next week', [2026, 9, 19, 9, 0]],
    ['next month', [2026, 10, 16, 9, 0]],
    ['this weekend', [2026, 9, 17, 9, 0]],
    ['fri', [2026, 9, 23, 9, 0]],
    ['monday', [2026, 9, 19, 9, 0]],
    ['next mon', [2026, 9, 19, 9, 0]],
    ['mon 9am', [2026, 9, 19, 9, 0]],
    ['thurs 17:30', [2026, 9, 22, 17, 30]],
    ['9am', [2026, 9, 17, 9, 0]],
    ['16:00', [2026, 9, 16, 16, 0]],
    ['noon', [2026, 9, 17, 12, 0]],
    ['12am', [2026, 9, 17, 0, 0]],
    ['oct 20', [2026, 9, 20, 9, 0]],
    ['20 oct', [2026, 9, 20, 9, 0]],
    ['october 20 2pm', [2026, 9, 20, 14, 0]],
    ['2026-10-20', [2026, 9, 20, 9, 0]],
    ['2026-10-20 18:15', [2026, 9, 20, 18, 15]],
    ['oct 10', [2027, 9, 10, 9, 0]],
    ['oct 20 2027', [2027, 9, 20, 9, 0]],
    ['oct 16 9am', [2027, 9, 16, 9, 0]],
    ['oct 20 1430', UNRECOGNIZED],
    ['oct 20 0026', UNRECOGNIZED],
    ['fri 14', UNRECOGNIZED],
    ['oct 20 14', UNRECOGNIZED],
    ['2026-10-20 9', UNRECOGNIZED],
    ['2025-01-01', PASSED],
    ['feb 30', 'That date does not exist'],
    ['blah', UNRECOGNIZED],
    ['13pm', UNRECOGNIZED],
    ['25:00', UNRECOGNIZED],
    ['', UNRECOGNIZED],
  ])('%s', (text, expected) => {
    expect(at(text)).toEqual(expected);
  });

  it('plans the weekend from Saturday', () => {
    expect(at('this weekend', new Date(2026, 9, 17, 8, 0))).toEqual([2026, 9, 17, 9, 0]);
    expect(at('this weekend', new Date(2026, 9, 17, 10, 0))).toEqual([2026, 9, 24, 9, 0]);
  });

  it('resolves year-less feb 29 to the next leap year', () => {
    expect(at('feb 29', new Date(2027, 2, 1))).toEqual([2028, 1, 29, 9, 0]);
    expect(at('feb 29', new Date(2028, 2, 1))).toEqual([2032, 1, 29, 9, 0]);
  });

  it('moves a time in the spring-forward gap ahead', () => {
    expect(at('tomorrow 2:30am', new Date(2027, 2, 27, 12, 0))).toEqual([2027, 2, 28, 3, 30]);
  });

  it('plans next week from Sunday and Monday', () => {
    expect(at('next week', new Date(2026, 9, 18, 10, 0))).toEqual([2026, 9, 19, 9, 0]);
    expect(at('next week', new Date(2026, 9, 19, 10, 0))).toEqual([2026, 9, 26, 9, 0]);
  });

  it('refuses later today that rounds to midnight', () => {
    expect(at('later today', new Date(2026, 9, 16, 21, 0))).toEqual('Too late for later today');
  });

  it('clamps next month to the last day', () => {
    expect(at('next month', new Date(2027, 0, 31, 10, 0))).toEqual([2027, 1, 28, 9, 0]);
  });

  it.each(SNOOZE_PRESETS)('preset $id parses', ({ phrase }) => {
    expect(parseSnooze(phrase, NOW).ok).toBe(true);
  });
});

describe('formatSnoozeTime', () => {
  it.each<[Date, string]>([
    [new Date(2026, 9, 16, 16, 30), 'Today, 16:30'],
    [new Date(2026, 9, 17, 9, 0), 'Tomorrow, 09:00'],
    [new Date(2026, 9, 21, 9, 0), 'Wed, 09:00'],
    [new Date(2026, 9, 23, 9, 0), 'Fri 23 Oct, 09:00'],
    [new Date(2026, 10, 20, 9, 0), 'Fri 20 Nov, 09:00'],
    [new Date(2027, 0, 5, 9, 0), 'Tue 5 Jan 2027, 09:00'],
  ])('%s', (date, expected) => {
    expect(formatSnoozeTime(date, NOW)).toBe(expected);
  });
});
