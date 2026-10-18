import { describe, expect, it, vi } from 'vitest';
import { syntheticRows } from '../dev/synthetic';
import { medianMs } from '../test/perf';
import type { OutboxEntry } from './outbox';
import { indexRows, projectCounts, searchRows, splitRows, visibleSessions } from './derive';

describe('derive performance', () => {
  vi.useRealTimers();
  const rows = syntheticRows(5000, Date.UTC(2026, 9, 16, 12));
  const pick = (i: number) => rows[(i * 2_654_435_761) % rows.length];
  const entries: OutboxEntry[] = Array.from({ length: 10 }, (_, i) => {
    const row = pick(i + 1);
    if (row === undefined) throw new Error('no row');
    return {
      decision: { ticket: i + 1, action: 'archive', row, until: null },
      state: 'pending',
      sendAt: 0,
    };
  });
  const applied = new Map(
    Array.from({ length: 10 }, (_, i) => [pick(i + 101)?.id ?? '', 1] as const),
  );

  it('indexes 5 000 rows within 25 ms', () => {
    const median = medianMs(() => indexRows(rows));
    console.info(`indexRows median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThanOrEqual(25);
  });

  it('runs the derive chain over 5 000 rows within 8 ms', () => {
    const index = indexRows(rows);
    const median = medianMs(() => {
      const visible = visibleSessions(rows, entries, applied);
      const all = splitRows(visible, 'all', index);
      projectCounts(all, index);
      searchRows(all, 'proj login', index);
    });
    console.info(`derive chain median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThanOrEqual(8);
  });
});
