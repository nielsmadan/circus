export const DAY_MS = 86_400_000;

// counted in UTC so that day arithmetic never meets a DST shift
export function localDayNumber(at: Date): number {
  return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / DAY_MS;
}

export interface DayBounds {
  readonly start: number;
  readonly end: number;
}

export function localDayBounds(nowMs: number): DayBounds {
  const now = new Date(nowMs);
  const midnight = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  return { start: midnight(0), end: midnight(1) };
}
