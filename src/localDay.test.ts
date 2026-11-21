import { describe, expect, it } from 'vitest';
import { localDayBounds } from './localDay';

describe('localDayBounds', () => {
  it('spans the local calendar day around the given time', () => {
    expect(localDayBounds(new Date(2026, 9, 14, 15, 30).getTime())).toEqual({
      start: new Date(2026, 9, 14).getTime(),
      end: new Date(2026, 9, 15).getTime(),
    });
  });

  it('spans the whole 25-hour day when the clocks go back', () => {
    const bounds = localDayBounds(new Date(2026, 9, 25, 12).getTime());
    expect(bounds).toEqual({
      start: new Date(2026, 9, 25).getTime(),
      end: new Date(2026, 9, 26).getTime(),
    });
    expect(bounds.end - bounds.start).toBe(25 * 3_600_000);
  });
});
