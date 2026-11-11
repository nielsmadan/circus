const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function spanText(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  if (Number.isNaN(ms)) return '?';
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))}m`;
  if (ms < 2 * DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}
