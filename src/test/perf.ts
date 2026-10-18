export function medianMs(
  run: () => void,
  { warmup = 5, runs = 21 }: { readonly warmup?: number; readonly runs?: number } = {},
): number {
  for (let i = 0; i < warmup; i += 1) run();
  const times = Array.from({ length: runs }, () => {
    const started = performance.now();
    run();
    return performance.now() - started;
  }).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const upper = times[middle] ?? Number.NaN;
  if (times.length % 2 === 1) return upper;
  return ((times[middle - 1] ?? Number.NaN) + upper) / 2;
}
