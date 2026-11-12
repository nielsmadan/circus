import { describe, expect, it } from 'vitest';
import { makeRow } from '../test/fixtures';
import type { SessionRow } from '../api/types';
import { indexRows } from './derive';
import { inScope, type Scope } from './scope';
import {
  dateEntries,
  folderEntries,
  folderTree,
  repoEntries,
  resolveScope,
  sidebarContent,
  tilde,
  type FolderNode,
} from './sidebarGroups';

describe('tilde', () => {
  it('abbreviates the home folder and leaves other paths alone', () => {
    expect(tilde('/u/wrksp/circus', '/u')).toBe('~/wrksp/circus');
    expect(tilde('/u', '/u/')).toBe('~');
    expect(tilde('/users/other', '/u')).toBe('/users/other');
    expect(tilde('/u/x', null)).toBe('/u/x');
    expect(tilde('/u/x', '/')).toBe('/u/x');
    expect(tilde('/u/x', '')).toBe('/u/x');
  });
});

describe('repoEntries', () => {
  it('keeps the queue order and shows the parent only for repeated names', () => {
    const entries = repoEntries(
      [
        { key: 'github.com/acme/web', label: 'web', pending: 3, oldestMtime: '' },
        { key: '/u/work/api', label: 'api', pending: 1, oldestMtime: '' },
        { key: 'gitlab.com/ops/web', label: 'web', pending: 2, oldestMtime: '' },
      ],
      '/u',
    );
    expect(entries.map(({ label, detail, count }) => [label, detail, count])).toEqual([
      ['web', 'github.com/acme/', 3],
      ['api', null, 1],
      ['web', 'gitlab.com/ops/', 2],
    ]);
    expect(entries[1]?.scope).toEqual({ kind: 'repo', key: '/u/work/api', label: 'api' });
  });
});

const HOME = '/home/me';
let serial = 0;
const at = (project: string | null, mtime = '2026-11-12T13:00:00+01:00'): SessionRow =>
  makeRow({ id: `t:${(serial += 1)}`, project, mtime });

type Shape = [string, string, number, number, Shape[]];
const shape = (nodes: readonly FolderNode[]): Shape[] =>
  nodes.map((n) => [n.name, n.path, n.own, n.total, shape(n.children)]);

describe('folderEntries', () => {
  it('is one entry per folder, labelled from home and sorted by label', () => {
    const rows = [
      at('/home/me/w/beta'),
      at('/home/me/w/beta'),
      at('/home/me/w/Alpha'),
      at('/opt/tool'),
      at(null),
    ];
    expect(folderEntries(rows, HOME).map((e) => [e.scope.key, e.detail, e.label, e.count])).toEqual(
      [
        ['/opt/tool', '/opt/', 'tool', 1],
        ['(unknown)', null, 'Unknown folder', 1],
        ['/home/me/w/Alpha', '~/w/', 'Alpha', 1],
        ['/home/me/w/beta', '~/w/', 'beta', 2],
      ],
    );
  });

  it('breaks a tie between equal labels by key', () => {
    expect(folderEntries([at('/x'), at('/X')], HOME).map((e) => e.scope.key)).toEqual(['/X', '/x']);
  });
});

describe('folderTree', () => {
  it('merges a chain of folders with no sessions of their own', () => {
    const rows = [
      at('/home/me/wrksp/circus/dev1'),
      at('/home/me/wrksp/circus/dev1'),
      at('/home/me/wrksp/ringleader/dev1'),
    ];
    expect(shape(folderTree(rows, HOME))).toEqual([
      [
        '~/wrksp',
        '/home/me/wrksp',
        0,
        3,
        [
          ['circus/dev1', '/home/me/wrksp/circus/dev1', 2, 2, []],
          ['ringleader/dev1', '/home/me/wrksp/ringleader/dev1', 1, 1, []],
        ],
      ],
    ]);
  });

  it('stops a chain at a folder with sessions of its own', () => {
    const rows = [at('/home/me/wrksp'), at('/home/me/wrksp/circus/dev1')];
    expect(shape(folderTree(rows, HOME))).toEqual([
      [
        '~/wrksp',
        '/home/me/wrksp',
        1,
        2,
        [['circus/dev1', '/home/me/wrksp/circus/dev1', 1, 1, []]],
      ],
    ]);
  });

  it('puts home first, then /, then the unknown folder last', () => {
    const rows = [at(null), at('/tmp/scratch'), at('/opt/tool'), at('/home/me')];
    expect(shape(folderTree(rows, HOME))).toEqual([
      ['~', '/home/me', 1, 1, []],
      [
        '/',
        '/',
        0,
        2,
        [
          ['opt/tool', '/opt/tool', 1, 1, []],
          ['tmp/scratch', '/tmp/scratch', 1, 1, []],
        ],
      ],
      ['Unknown folder', '(unknown)', 1, 1, []],
    ]);
  });

  it('merges a root outside home into one path', () => {
    expect(shape(folderTree([at('/opt/tool')], HOME))).toEqual([
      ['/opt/tool', '/opt/tool', 1, 1, []],
    ]);
  });

  it('sorts children by name, ignoring case', () => {
    const rows = ['beta', 'Alpha', 'gamma'].map((name) => at(`/home/me/${name}`));
    expect(folderTree(rows, HOME)[0]?.children.map((n) => n.name)).toEqual([
      'Alpha',
      'beta',
      'gamma',
    ]);
  });

  it('places a relative folder before the unknown folder', () => {
    expect(
      folderTree([at(null), at('relative/dir')], HOME).map((n) => [n.name, n.path, n.total]),
    ).toEqual([
      ['relative/dir', 'relative/dir', 1],
      ['Unknown folder', '(unknown)', 1],
    ]);
  });

  it('gives the / root only what its row counts and leaves home to the ~ root', () => {
    const rows = [at('/opt/tool'), at('/tmp/x'), at('/home/me/w')];
    const [homeRoot, slashRoot] = folderTree(rows, HOME);
    if (homeRoot === undefined || slashRoot === undefined) throw new Error('missing roots');
    expect(rows.map((row) => inScope(row, slashRoot.scope, 0))).toEqual([true, true, false]);
    expect(rows.map((row) => inScope(row, homeRoot.scope, 0))).toEqual([false, false, true]);
    expect(slashRoot.scope.label).toBe('/ except ~');
  });

  it('hangs a folder that only shares a prefix with home from the / root', () => {
    expect(shape(folderTree([at('/home/meow/x')], HOME))).toEqual([
      ['/home/meow/x', '/home/meow/x', 1, 1, []],
    ]);
  });

  it('leaves home out of a folder above it', () => {
    const rows = [at('/home/ann/x'), at('/home/bob/y'), at('/home/me/w')];
    const node = folderTree(rows, HOME)[1];
    if (node === undefined) throw new Error('missing /home');
    expect([node.name, node.path, node.total]).toEqual(['/home', '/home', 2]);
    expect(rows.filter((row) => inScope(row, node.scope, 0))).toHaveLength(node.total);
  });

  it('matches only folderless sessions from the unknown folder', () => {
    const node = folderTree([at(null)], HOME)[0];
    if (node === undefined) throw new Error('missing unknown');
    expect([at(null), at('/opt')].map((row) => inScope(row, node.scope, 0))).toEqual([true, false]);
  });
});

describe('folderTree scopes and edges', () => {
  it('labels each node by its home path, and only the / root leaves out home', () => {
    const rows = [at('/home/me/a/x'), at('/home/me/b'), at('/opt/tool'), at('/srv/y')];
    const labels = (nodes: readonly FolderNode[]): unknown[] =>
      nodes.map((n) => [n.scope.label, labels(n.children)]);
    expect(labels(folderTree(rows, HOME))).toEqual([
      [
        '~',
        [
          ['~/a/x', []],
          ['~/b', []],
        ],
      ],
      [
        '/ except ~',
        [
          ['/opt/tool', []],
          ['/srv/y', []],
        ],
      ],
    ]);
  });

  it('hangs everything from / without a home', () => {
    for (const home of [null, '/', '']) {
      const roots = folderTree([at('/home/me/a'), at('/opt/b')], home);
      expect(roots.map((n) => [n.name, n.scope.label, n.total])).toEqual([['/', '/', 2]]);
    }
  });

  it('counts an empty folder as unknown', () => {
    expect(folderTree([at('')], HOME).map((n) => [n.name, n.total])).toEqual([
      ['Unknown folder', 1],
    ]);
  });

  it('keeps a path too deep for any real folder as a single row', () => {
    const deep = `/${'a/'.repeat(5000)}x`;
    expect(folderTree([at(deep)], HOME).map((n) => [n.path, n.total])).toEqual([[deep, 1]]);
  });
});

describe('dateEntries', () => {
  // these run with TZ=Europe/Berlin, which the test script sets
  const NOW = Date.parse('2026-11-12T15:00:00+01:00');
  const daysAgo = (n: number) =>
    makeRow({ id: `d:${n}`, mtime: new Date(NOW - n * 86_400_000).toISOString() });
  const local = (iso: string) => new Date(iso).getTime();
  const entries = (rows: readonly SessionRow[], now = NOW) =>
    dateEntries(rows, indexRows(rows), now);
  const range = (rows: readonly SessionRow[], now = NOW) =>
    entries(rows, now).map((e) =>
      e.scope.kind === 'period' ? [e.scope.key, e.scope.start, e.scope.end] : [],
    );

  it('runs days, then weeks, then months, newest first', () => {
    const rows = [0, 1, 6, 7, 14, 45, 62, 90].map(daysAgo);
    const shown = entries(rows);
    expect(shown.map((e) => e.scope.key)).toEqual([
      'day:2026-11-12',
      'day:2026-11-11',
      'day:2026-11-06',
      'week:2026-11-02',
      'week:2026-10-26',
      'week:2026-09-28',
      'month:2026-09',
      'month:2026-08',
    ]);
    expect(shown.map((e) => e.label)).toEqual(shown.map((e) => e.scope.key.split(':')[1]));
  });

  it('leaves out empty periods and counts the rest', () => {
    const rows = [
      makeRow({ id: 'a', mtime: '2026-11-11T09:00:00+01:00' }),
      makeRow({ id: 'b', mtime: '2026-11-11T18:00:00+01:00' }),
    ];
    expect(entries(rows).map((e) => [e.scope.key, e.count])).toEqual([['day:2026-11-11', 2]]);
    expect(range(rows)).toEqual([
      ['day:2026-11-11', local('2026-11-11T00:00:00+01:00'), local('2026-11-12T00:00:00+01:00')],
    ]);
  });

  it('ends a week the day range overlaps where the days begin', () => {
    expect(range([makeRow({ mtime: '2026-11-03T12:00:00+01:00' })])).toEqual([
      ['week:2026-11-02', local('2026-11-02T00:00:00+01:00'), local('2026-11-06T00:00:00+01:00')],
    ]);
  });

  it('ends the oldest month where the oldest week begins', () => {
    expect(range([makeRow({ mtime: '2026-09-02T12:00:00+02:00' })])).toEqual([
      ['month:2026-09', local('2026-09-01T00:00:00+02:00'), local('2026-09-14T00:00:00+02:00')],
    ]);
  });

  it('runs a DST week from local midnight to local midnight', () => {
    const rows = [
      makeRow({ id: 'sun', mtime: '2026-10-25T22:30:00Z' }),
      makeRow({ id: 'mon', mtime: '2026-10-25T23:30:00Z' }),
    ];
    const [after, dst] = range(rows);
    expect([dst?.[0], after?.[0]]).toEqual(['week:2026-10-19', 'week:2026-10-26']);
    expect(dst?.[1]).toBe(local('2026-10-19T00:00:00+02:00'));
    expect(dst?.[2]).toBe(local('2026-10-26T00:00:00+01:00'));
    expect(Number(dst?.[2]) - Number(dst?.[1])).toBe(7 * 86_400_000 + 3_600_000);
  });

  it('starts the oldest week where the months end', () => {
    const rows = [
      makeRow({ id: 'w', mtime: '2026-09-14T12:00:00+02:00' }),
      makeRow({ id: 'm', mtime: '2026-09-13T12:00:00+02:00' }),
    ];
    expect(entries(rows).map((e) => e.scope.key)).toEqual(['week:2026-09-14', 'month:2026-09']);
  });

  it('ends a December bucket at new year', () => {
    const now = Date.parse('2027-03-10T12:00:00+01:00');
    expect(range([makeRow({ mtime: '2026-12-05T12:00:00+01:00' })], now)).toEqual([
      ['month:2026-12', local('2026-12-01T00:00:00+01:00'), local('2027-01-01T00:00:00+01:00')],
    ]);
  });

  it('counts an mtime in the future as today', () => {
    const rows = [
      makeRow({ id: 'f', mtime: new Date(NOW + 3 * 86_400_000).toISOString() }),
      daysAgo(0),
    ];
    const [today] = entries(rows);
    expect([today?.scope.key, today?.count]).toEqual(['day:2026-11-12', 2]);
    const index = indexRows(rows);
    expect(
      rows.map(
        (row) => today !== undefined && inScope(row, today.scope, index.mtimeMs.get(row.id) ?? 0),
      ),
    ).toEqual([true, true]);
  });
});

describe('dates with unreadable times', () => {
  it('leaves out a session whose last activity cannot be read', () => {
    const rows = [
      makeRow({ id: 'bad', mtime: 'garbage' }),
      makeRow({ id: 'ok', mtime: '2026-11-11T12:00:00+01:00' }),
    ];
    const shown = dateEntries(rows, indexRows(rows), Date.parse('2026-11-12T15:00:00+01:00'));
    expect(shown.map((e) => [e.scope.key, e.count])).toEqual([['day:2026-11-11', 1]]);
  });
});

describe('resolveScope', () => {
  // these run with TZ=Europe/Berlin, which the test script sets
  const rows = [
    makeRow({ id: 'a', mtime: '2026-11-11T12:00:00+01:00', project: '/home/me/w' }),
    makeRow({ id: 'b', mtime: '2026-11-04T12:00:00+01:00', project: '/opt/x' }),
    makeRow({ id: 'c', mtime: '2026-11-04T12:00:00+01:00', project: '/srv/y' }),
  ];
  const index = indexRows(rows);
  const content = (view: 'dates' | 'tree' | 'folders', nowMs: number) =>
    sidebarContent(view, { projects: [], rows, index, home: HOME, nowMs });
  const nov11 = Date.parse('2026-11-11T15:00:00+01:00');
  const nov12 = Date.parse('2026-11-12T15:00:00+01:00');
  const nov19 = Date.parse('2026-11-19T15:00:00+01:00');

  it("gives today's selection a closing bound once the day is over", () => {
    const today = content('dates', nov11);
    const selected = today.kind === 'list' ? (today.entries[0]?.scope ?? null) : null;
    expect(selected).toMatchObject({ key: 'day:2026-11-11', end: null });
    expect(resolveScope(selected, content('dates', nov12), nov12)).toMatchObject({
      key: 'day:2026-11-11',
      end: new Date(2026, 10, 12).getTime(),
    });
  });

  it('drops a day once it has rolled into a week', () => {
    const selected = resolveScope(
      { kind: 'period', key: 'day:2026-11-11', label: '', period: 'day', start: 0, end: 1 },
      content('dates', nov12),
      nov12,
    );
    expect(selected).toMatchObject({ key: 'day:2026-11-11' });
    expect(resolveScope(selected, content('dates', nov19), nov19)).toBeNull();
  });

  it('takes a tree selection from the current tree, and keeps an emptied folder', () => {
    const slash: Scope = { kind: 'tree', key: '/', label: '/', excluding: null };
    expect(resolveScope(slash, content('tree', nov12), nov12)).toMatchObject({
      key: '/',
      excluding: HOME,
    });
    const slashRoot: Scope = { kind: 'tree', key: '/', label: '/ except ~', excluding: HOME };
    const merged = sidebarContent('tree', {
      projects: [],
      rows: rows.filter((row) => row.id !== 'c'),
      index,
      home: HOME,
      nowMs: nov12,
    });
    expect(resolveScope(slashRoot, merged, nov12)).toMatchObject({ key: '/opt/x' });
    const gone: Scope = { kind: 'folder', key: '/gone', label: '/gone' };
    expect(resolveScope(gone, content('folders', nov12), nov12)).toBe(gone);
  });
});
