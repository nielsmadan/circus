import { describe, expect, it } from 'vitest';
import { makeRow } from '../test/fixtures';
import { fakeHome } from './fakeHome';

const older = makeRow({
  id: 'claude-code:o',
  mtime: '2026-10-01T00:00:00',
  in_recent: false,
  project_key: '/u/b',
  project_label: 'beta',
});
const newer = makeRow({
  id: 'claude-code:n',
  mtime: '2026-10-14T00:00:00+00:00',
  status: 'active',
  project_key: '/u/b',
  project_label: 'beta',
});
const other = makeRow({
  id: 'claude-code:x',
  mtime: '2026-10-12T00:00:00+00:00',
  project_key: '/u/a',
  project_label: 'alpha',
});

describe('fakeHome', () => {
  it('queues projects oldest first, as the inbox sidebar does', () => {
    expect(fakeHome([newer, other, older], 0, false).projects).toEqual([
      {
        key: '/u/b',
        label: 'beta',
        pending: 2,
        unclassified: 1,
        oldest_mtime: older.mtime,
        newest_mtime: newer.mtime,
      },
      {
        key: '/u/a',
        label: 'alpha',
        pending: 1,
        unclassified: 1,
        oldest_mtime: other.mtime,
        newest_mtime: other.mtime,
      },
    ]);
  });

  it('lists the next steps in ringleader order, with a project step for the backlog', () => {
    const home = fakeHome([newer, other, older], 2, true);
    expect(home.next_steps.map((step) => [step.kind, step.count, step.project_key])).toEqual([
      ['roundup', null, null],
      ['recent', 2, null],
      ['publish', 2, null],
      ['project', 2, '/u/b'],
    ]);
  });

  it('lists recent live sessions in flight, newest first, and counts them', () => {
    const home = fakeHome([other, newer, older], 0, false);
    expect(home.in_flight).toEqual([newer.id, other.id]);
    expect(home.counts).toMatchObject({ triage_total: 3, live: 1, unclassified: 2, projects: 2 });
  });
});
