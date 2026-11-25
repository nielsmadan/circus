import { describe, expect, it, vi } from 'vitest';
import { syntheticRows } from '../dev/synthetic';
import { medianMs } from '../test/perf';
import { filterByScope, indexRows } from './derive';
import type { Scope } from './scope';
import { dateEntries, folderEntries, folderTree } from './sidebarGroups';
import { scopeProject } from './targets';

describe('sidebar grouping performance', () => {
  vi.useRealTimers();
  const now = Date.UTC(2026, 9, 16, 12);
  const rows = syntheticRows(5000, now);
  const index = indexRows(rows);
  const wrksp: Scope = { kind: 'tree', key: '/u/wrksp', label: '~/wrksp', excluding: null };

  it('groups 5 000 rows by folder, folder tree and date, and filters a folder, within 15 ms', () => {
    const median = medianMs(() => {
      folderEntries(rows, '/u');
      folderTree(rows, '/u');
      dateEntries(rows, index, now);
      scopeProject(wrksp, filterByScope(rows, wrksp, index));
    });
    console.info(`sidebar groupings median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThanOrEqual(15);
  });
});
