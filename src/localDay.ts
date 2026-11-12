export const DAY_MS = 86_400_000;

// counted in UTC so that day arithmetic never meets a DST shift
export function localDayNumber(at: Date): number {
  return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / DAY_MS;
}
