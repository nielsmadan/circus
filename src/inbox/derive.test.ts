import { describe, expect, it } from 'vitest';
import type { AppInfo, SessionRow } from '../api/types';
import { makeList, makeRow } from '../test/fixtures';
import type { OutboxEntry } from './outbox';
import {
  clientRefusal,
  decisionGuard,
  filterByProject,
  hiddenIds,
  indexRows,
  nextSelection,
  parseMtime,
  positions,
  projectCounts,
  searchRows,
  splitCounts,
  splitRows,
  visibleSessions,
} from './derive';

function pendingEntry(row: SessionRow): OutboxEntry {
  return {
    decision: { ticket: 1, action: 'archive', row, until: null },
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

  it('counts the three splits', () => {
    expect(splitCounts(rows)).toEqual({ recent: 3, woke: 2, all: 4 });
  });

  it('leaves its input in place', () => {
    const before = [...rows];
    splitRows(rows, 'all', index);
    expect(rows).toEqual(before);
  });
});

describe('filterByProject and projectCounts', () => {
  it('returns the input for null and filters by key otherwise', () => {
    expect(filterByProject(rows, null)).toBe(rows);
    expect(ids(filterByProject(rows, '/u/a'))).toEqual([d.id, b.id]);
  });

  it('labels each project from its oldest row and sorts case-insensitively', () => {
    expect(projectCounts(rows, indexRows(rows))).toEqual([
      { key: '/u/a', label: 'alpha', pending: 2 },
      { key: '/u/b', label: 'Beta', pending: 2 },
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

  it('keeps the selected id while it is still shown', () => {
    expect(nextSelection([r0, r1, r2], [r1, r2], r2.id)).toBe(r2.id);
  });

  it('moves to the row now at the same index after removal', () => {
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
  it('names the ringleader-finish skill for a running row', () => {
    expect(clientRefusal('archive', makeRow({ label: 'L', running: true }))).toBe(
      'L is running — finish it from inside with the ringleader-finish skill',
    );
  });

  it('refuses while presence is unknown', () => {
    expect(clientRefusal('harvest', makeRow({ label: 'L', running: null }))).toMatch(
      /^Can't tell whether L is running/,
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

  it('refuses a lifecycle-blocked delete, naming delete', () => {
    expect(
      clientRefusal(
        'delete',
        makeRow({ lifecycle_block: 'cannot archive x: no filesystem transcript lifecycle' }),
      ),
    ).toBe('cannot delete x: no filesystem transcript lifecycle');
  });

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
