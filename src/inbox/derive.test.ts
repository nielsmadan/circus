import { describe, expect, it } from 'vitest';
import type { AppInfo, SessionRow } from '../api/types';
import { makeList, makeRow } from '../test/fixtures';
import type { OutboxEntry } from './outbox';
import {
  clientRefusal,
  decisionGuard,
  filterByScope,
  hiddenIds,
  indexRows,
  narrowRows,
  nextSelection,
  parseMtime,
  positions,
  projectCounts,
  searchRows,
  splitCounts,
  splitRows,
  visibleSessions,
} from './derive';
import type { Scope } from './scope';

function pendingEntry(row: SessionRow): OutboxEntry {
  return {
    decision: { ticket: 1, batchId: 1, action: 'archive', row, until: null },
    state: 'pending',
    sendAt: 4_000,
  };
}

function ids(rows: readonly SessionRow[]): string[] {
  return rows.map((row) => row.id);
}

const appInfo: AppInfo = {
  rl_command: ['rl'],
  rl_source: 'env',
  shell_probe: 'skipped',
  environment_label: null,
  world_root: null,
  resume_dry_run: false,
  terminal: 'iterm2',
  settings_path: '/u/settings.json',
  home_dir: '/u',
};

const a = makeRow({
  id: 'claude-code:a',
  mtime: '2026-10-01T00:00:00+00:00',
  in_recent: false,
  woke: true,
  project_key: '/u/b',
  project_label: 'Beta',
});
const b = makeRow({
  id: 'claude-code:b',
  mtime: '2026-10-12T00:00:00+00:00',
  in_recent: true,
  project_key: '/u/a',
  project_label: 'alpha',
});
const c = makeRow({
  id: 'claude-code:c',
  mtime: '2026-10-14T00:00:00+00:00',
  in_recent: true,
  woke: true,
  project_key: '/u/b',
  project_label: 'beta (newer)',
});
const d = makeRow({
  id: 'codex:d',
  mtime: '2026-10-14T00:00:00+00:00',
  in_recent: true,
  project_key: '/u/a',
  project_label: 'alpha',
});
const rows = [c, a, d, b];

describe('indexRows', () => {
  it('maps each id to its parsed mtime and a lowercase haystack', () => {
    const row = makeRow({ id: 'claude-code:x', label: 'Fix Login', git_branch: 'Feat/Search' });
    const index = indexRows([row]);
    expect(index.mtimeMs.get('claude-code:x')).toBe(Date.parse(row.mtime));
    expect(index.haystack.get('claude-code:x')).toContain('fix login');
    expect(index.haystack.get('claude-code:x')).toContain('feat/search');
  });
});

describe('parseMtime', () => {
  it('reads an offset-less timestamp as UTC and leaves offsets alone', () => {
    expect(parseMtime('2026-10-01T10:00:00')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(parseMtime('2026-10-01T10:00:00+02:00')).toBe(Date.parse('2026-10-01T08:00:00Z'));
    expect(parseMtime('2026-10-01T10:00:00.5Z')).toBe(Date.parse('2026-10-01T10:00:00.5Z'));
  });
});

describe('visibleSessions', () => {
  it('hides pending and applied rows and shows the rest', () => {
    expect(ids(visibleSessions(rows, [pendingEntry(a)], new Map([[b.id, 1]])))).toEqual([
      c.id,
      d.id,
    ]);
    expect(hiddenIds([pendingEntry(a)])).toEqual(new Set([a.id]));
  });

  it('returns the same array when nothing is hidden', () => {
    expect(visibleSessions(rows, [], new Map())).toBe(rows);
    expect(visibleSessions(rows, [pendingEntry(makeRow({ id: 'gone:x' }))], new Map())).toBe(rows);
  });
});

describe('splitRows and splitCounts', () => {
  const index = indexRows(rows);

  it('orders recent newest first and keeps only recent rows', () => {
    expect(ids(splitRows(rows, 'recent', index))).toEqual([c.id, d.id, b.id]);
  });

  it('orders woke and all oldest first with ties by id', () => {
    expect(ids(splitRows(rows, 'woke', index))).toEqual([a.id, c.id]);
    expect(ids(splitRows(rows, 'all', index))).toEqual([a.id, b.id, c.id, d.id]);
  });

  it('falls back to parsing a row missing from the index', () => {
    expect(ids(splitRows(rows, 'all', indexRows([])))).toEqual([a.id, b.id, c.id, d.id]);
  });

  it('orders a visible subset using its current row objects', () => {
    const updated = { ...c, label: 'Updated label' };
    const sorted = splitRows([updated, a], 'all', index);
    expect(sorted).toEqual([a, updated]);
    expect(sorted[1]).toBe(updated);
  });

  it('preserves duplicate rows when sorting', () => {
    expect(splitRows([c, a, c], 'all', index)).toEqual([a, c, c]);
  });

  it('returns each visible row once when the index source repeats an id', () => {
    expect(splitRows([c, a], 'all', indexRows([a, c, a]))).toEqual([a, c]);
  });

  it('counts the three splits', () => {
    expect(splitCounts(rows)).toEqual({ recent: 3, woke: 2, all: 4 });
  });

  it('leaves its input in place', () => {
    const before = [...rows];
    splitRows(rows, 'all', index);
    expect(rows).toEqual(before);
  });
});

const repo = (key: string): Scope => ({ kind: 'repo', key, label: key });

describe('filterByScope and projectCounts', () => {
  const index = indexRows(rows);

  it('returns the input for null and filters by project key for a repo', () => {
    expect(filterByScope(rows, null, index)).toBe(rows);
    expect(ids(filterByScope(rows, repo('/u/a'), index))).toEqual([d.id, b.id]);
  });

  it('filters a period by last activity, start inclusive and end exclusive', () => {
    const period: Scope = {
      kind: 'period',
      key: 'day:2026-10-14',
      label: 'Wed 14 Oct',
      period: 'day',
      start: Date.parse('2026-10-12T00:00:00Z'),
      end: Date.parse('2026-10-14T00:00:00Z'),
    };
    expect(ids(filterByScope(rows, period, index))).toEqual([b.id]);
  });

  it('narrows to a scope and a query together', () => {
    expect(ids(narrowRows(rows, repo('/u/a'), '', index))).toEqual([d.id, b.id]);
    expect(ids(narrowRows(rows, repo('/u/b'), 'newer', index))).toEqual([c.id]);
    expect(narrowRows(rows, repo('/u/a'), 'newer', index)).toEqual([]);
    expect(narrowRows(rows, null, '', index)).toBe(rows);
  });

  it('labels each project from its oldest row and queues the oldest activity first', () => {
    expect(projectCounts(rows, indexRows(rows))).toEqual([
      { key: '/u/b', label: 'Beta', pending: 2, oldestMtime: a.mtime },
      { key: '/u/a', label: 'alpha', pending: 2, oldestMtime: b.mtime },
    ]);
  });

  it('breaks a tie in oldest activity by label, case-insensitively', () => {
    const tied = [
      makeRow({ id: 'claude-code:x', project_key: '/u/x', project_label: 'Zed' }),
      makeRow({
        id: 'claude-code:y',
        project_key: '/u/y',
        project_label: 'ant',
        status: 'finished',
      }),
    ];
    expect(projectCounts(tied, indexRows(tied))).toEqual([
      { key: '/u/y', label: 'ant', pending: 1, oldestMtime: tied[1]?.mtime },
      { key: '/u/x', label: 'Zed', pending: 1, oldestMtime: tied[0]?.mtime },
    ]);
  });
});

describe('searchRows', () => {
  const flaky = makeRow({ id: 'claude-code:f', label: 'fix flaky login' });
  const parser = makeRow({ id: 'claude-code:p', label: 'fix parser' });
  const both = [flaky, parser];

  it('matches rows containing every term', () => {
    expect(ids(searchRows(both, 'login fix', indexRows(both)))).toEqual([flaky.id]);
    expect(ids(searchRows(both, '  FIX ', indexRows(both)))).toEqual([flaky.id, parser.id]);
  });

  it('builds the haystack for a row missing from the index', () => {
    expect(ids(searchRows(both, 'parser', indexRows([])))).toEqual([parser.id]);
  });

  it('returns the input for an empty query', () => {
    expect(searchRows(both, ' ', indexRows(both))).toBe(both);
  });
});

describe('positions and nextSelection', () => {
  const [r0, r1, r2] = [
    makeRow({ id: 'claude-code:0' }),
    makeRow({ id: 'claude-code:1' }),
    makeRow({ id: 'claude-code:2' }),
  ];

  it('maps ids to their indices', () => {
    expect(positions([r0, r1, r2])).toEqual(
      new Map([
        [r0.id, 0],
        [r1.id, 1],
        [r2.id, 2],
      ]),
    );
  });

  it('moves to the first remaining row after the selected one when several rows go', () => {
    const [r3, r4] = [makeRow({ id: 'claude-code:3' }), makeRow({ id: 'claude-code:4' })];
    expect(nextSelection([r0, r1, r2, r3, r4], [r0, r3, r4], r2.id)).toBe(r3.id);
  });

  it('keeps the selected id while it is still shown', () => {
    expect(nextSelection([r0, r1, r2], [r1, r2], r2.id)).toBe(r2.id);
  });

  it('falls back to the first row when the selected row was never shown', () => {
    const gone = makeRow({ id: 'claude-code:r0' });
    const fresh = makeRow({ id: 'claude-code:r1' });
    expect(nextSelection([gone], [fresh], 'claude-code:gone')).toBe(fresh.id);
  });

  it('moves to the next remaining row after a single removal', () => {
    expect(nextSelection([r0, r1, r2], [r0, r2], r1.id)).toBe(r2.id);
  });

  it('clamps at the end of the list', () => {
    expect(nextSelection([r0, r1, r2], [r0, r1], r2.id)).toBe(r1.id);
  });

  it('selects the first row when nothing was selected and null for an empty list', () => {
    expect(nextSelection([], [r0, r1], null)).toBe(r0.id);
    expect(nextSelection([r0], [], r0.id)).toBeNull();
  });
});

describe('clientRefusal', () => {
  it('asks to wait for a running row', () => {
    expect(clientRefusal('archive', makeRow({ label: 'L', running: true }))).toBe(
      'L is still running — try again once it has stopped',
    );
  });

  it('refuses while presence is unknown', () => {
    expect(clientRefusal('harvest', makeRow({ label: 'L', running: null }))).toBe(
      'Can’t tell whether L is running, so archive, delete and harvest are off for now',
    );
  });

  it('passes a non-destructive action on a running row', () => {
    expect(clientRefusal('keep_going', makeRow({ running: true }))).toBeNull();
  });

  it.each(['archive', 'harvest'] as const)('returns the lifecycle block text for %s', (action) => {
    expect(clientRefusal(action, makeRow({ lifecycle_block: 'not a plain file' }))).toBe(
      'not a plain file',
    );
  });

  it.each(['delete', 'harvest', 'archive'] as const)(
    'refuses a lifecycle-blocked %s, naming the action',
    (action) => {
      expect(
        clientRefusal(
          action,
          makeRow({ lifecycle_block: 'cannot archive x: no filesystem transcript lifecycle' }),
        ),
      ).toBe(`cannot ${action} x: no filesystem transcript lifecycle`);
    },
  );

  it('refuses a lifecycle-blocked delete with other text as given', () => {
    expect(clientRefusal('delete', makeRow({ lifecycle_block: 'not a plain file' }))).toBe(
      'not a plain file',
    );
  });

  it('asks for a rescan when the row has no fingerprint', () => {
    expect(clientRefusal('delete', makeRow({ label: 'L', file_fingerprint: null }))).toBe(
      'L has no fingerprint — rescan first (⌘K › Rescan sessions)',
    );
  });

  it('passes a row that can be archived', () => {
    expect(clientRefusal('archive', makeRow())).toBeNull();
  });
});

describe('decisionGuard', () => {
  const sandbox: AppInfo = { ...appInfo, environment_label: 'SANDBOX', world_root: '/w' };

  it('allows decisions outside a sandbox', () => {
    expect(decisionGuard(appInfo, null)).toBeNull();
  });

  it('waits while info or the list is loading', () => {
    expect(decisionGuard(null, makeList([]))).toBe('Loading…');
    expect(decisionGuard(sandbox, null)).toBe('Loading…');
  });

  it('refuses a sandbox without a world root', () => {
    expect(decisionGuard({ ...sandbox, world_root: null }, makeList([]))).toBe(
      'Sandbox without CIRCUS_WORLD_ROOT — decisions are disabled',
    );
  });

  it('refuses a registry outside the world root', () => {
    expect(decisionGuard(sandbox, makeList([], { registry: '/x/registry.json' }))).toBe(
      'Sandbox registry /x/registry.json is outside /w — decisions are disabled',
    );
  });

  it('allows a registry inside the world root', () => {
    expect(
      decisionGuard(sandbox, makeList([], { registry: '/w/xdg-data/ringleader/registry.json' })),
    ).toBeNull();
  });
});
