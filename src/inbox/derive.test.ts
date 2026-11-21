import { describe, expect, it } from 'vitest';
import type { AppInfo, SessionRow } from '../api/types';
import { localDayBounds } from '../localDay';
import { makeKeptRow, makeList, makeRow, makeSnoozedRow } from '../test/fixtures';
import type { OutboxEntry } from './outbox';
import {
  acceptsAny,
  availableSplits,
  clientRefusal,
  decisionGuard,
  filterByScope,
  hiddenIds,
  indexRows,
  isSnoozed,
  offers,
  listedRows,
  narrowRows,
  nextSelection,
  parseMtime,
  positions,
  projectCounts,
  searchRows,
  sourcesOf,
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

function inbox(sessions: readonly SessionRow[]) {
  return { sessions, kept: [], snoozed: [] };
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
    expect(ids(splitRows(inbox(rows), 'recent', index, null))).toEqual([c.id, d.id, b.id]);
  });

  it('orders woke and all oldest first with ties by id', () => {
    expect(ids(splitRows(inbox(rows), 'woke', index, null))).toEqual([a.id, c.id]);
    expect(ids(splitRows(inbox(rows), 'all', index, null))).toEqual([a.id, b.id, c.id, d.id]);
  });

  it('falls back to parsing a row missing from the index', () => {
    expect(ids(splitRows(inbox(rows), 'all', indexRows([]), null))).toEqual([
      a.id,
      b.id,
      c.id,
      d.id,
    ]);
  });

  it('orders a visible subset using its current row objects', () => {
    const updated = { ...c, label: 'Updated label' };
    const sorted = splitRows(inbox([updated, a]), 'all', index, null);
    expect(sorted).toEqual([a, updated]);
    expect(sorted[1]).toBe(updated);
  });

  it('preserves duplicate rows when sorting', () => {
    expect(splitRows(inbox([c, a, c]), 'all', index, null)).toEqual([a, c, c]);
  });

  it('returns each visible row once when the index source repeats an id', () => {
    expect(splitRows(inbox([c, a]), 'all', indexRows([a, c, a]), null)).toEqual([a, c]);
  });

  it('counts the inbox splits and the kept rows', () => {
    const snoozed = [makeSnoozedRow({ id: 's:1' }), makeSnoozedRow({ id: 's:2' })];
    const today = localDayBounds(parseMtime(c.mtime));
    expect(splitCounts({ sessions: rows, kept: [a], snoozed }, index, today)).toEqual({
      today: 2,
      recent: 3,
      woke: 2,
      all: 4,
      snoozed: 2,
      kept: 1,
    });
  });

  it('lists today’s inbox rows newest first, bounded by local midnight', () => {
    const at = (hour: number, minute = 0) => new Date(2026, 9, 14, hour, minute).toISOString();
    const midnight = makeRow({ id: 't:midnight', mtime: at(0) });
    const early = makeRow({ id: 't:early', mtime: at(0, 5) });
    const late = makeRow({ id: 't:late', mtime: at(23, 55) });
    const yesterday = makeRow({
      id: 't:yesterday',
      mtime: new Date(2026, 9, 13, 23, 59).toISOString(),
    });
    const tomorrow = makeRow({
      id: 't:tomorrow',
      mtime: new Date(2026, 9, 15, 0, 0).toISOString(),
    });
    const day = [midnight, early, late, yesterday, tomorrow];
    const today = localDayBounds(new Date(2026, 9, 14, 12).getTime());
    expect(ids(splitRows(inbox(day), 'today', indexRows(day), today))).toEqual([
      't:late',
      't:early',
      't:midnight',
    ]);
    expect(splitRows(inbox(day), 'today', indexRows(day), null)).toEqual([]);
  });

  it('orders snoozed rows by when they wake, open-ended last, ties by id', () => {
    const soonB = makeSnoozedRow({ id: 's:soon-b', snoozed_until: '2026-10-18T09:00:00+00:00' });
    const soonA = makeSnoozedRow({ id: 's:soon-a', snoozed_until: '2026-10-18T09:00:00+00:00' });
    const later = makeSnoozedRow({ id: 's:later', snoozed_until: '2026-11-01T09:00:00+00:00' });
    const open = makeSnoozedRow({ id: 's:open', snoozed_until: null });
    const garbled = makeSnoozedRow({ id: 's:garbled', snoozed_until: 'next tuesday' });
    const snoozed = [garbled, open, later, soonB, soonA];
    expect(ids(splitRows({ sessions: rows, kept: [], snoozed }, 'snoozed', index, null))).toEqual([
      's:soon-a',
      's:soon-b',
      's:later',
      's:garbled',
      's:open',
    ]);
  });

  it('orders kept rows by when they were kept, newest first with ties by id', () => {
    const early = makeKeptRow({ id: 'k:early', kept_at: '2026-10-01T09:00:00+00:00' });
    const lateB = makeKeptRow({ id: 'k:late-b', kept_at: '2026-10-05T09:00:00+00:00' });
    const lateA = makeKeptRow({ id: 'k:late-a', kept_at: '2026-10-05T09:00:00+00:00' });
    const kept = [early, lateB, lateA];
    expect(
      ids(splitRows({ sessions: rows, kept, snoozed: [] }, 'kept', indexRows(kept), null)),
    ).toEqual(['k:late-a', 'k:late-b', 'k:early']);
  });

  it('orders a kept row without a keep time by its last activity', () => {
    const early = makeKeptRow({ id: 'k:early', kept_at: '2026-10-01T09:00:00+00:00' });
    const late = makeKeptRow({ id: 'k:late', kept_at: '2026-10-05T09:00:00+00:00' });
    const between = makeKeptRow({
      id: 'k:between',
      kept_at: null,
      mtime: '2026-10-03T09:00:00+00:00',
    });
    const kept = [early, between, late];
    expect(
      ids(splitRows({ sessions: [], kept, snoozed: [] }, 'kept', indexRows(kept), null)),
    ).toEqual(['k:late', 'k:between', 'k:early']);
  });

  it('places a single row in the split its own state belongs to', () => {
    const kept = makeKeptRow({ id: 'k:one' });
    const snoozed = makeSnoozedRow({ id: 's:one' });
    expect(ids(splitRows(sourcesOf(snoozed), 'snoozed', index, null))).toEqual(['s:one']);
    expect(
      ids(
        splitRows(
          sourcesOf(makeKeptRow({ id: 'k:sn', snoozed_at: snoozed.snoozed_at })),
          'kept',
          index,
          null,
        ),
      ),
    ).toEqual(['k:sn']);
    expect(ids(splitRows(sourcesOf(kept), 'kept', index, null))).toEqual(['k:one']);
    expect(ids(splitRows(sourcesOf(kept), 'all', index, null))).toEqual([]);
    expect(ids(splitRows(sourcesOf(a), 'all', index, null))).toEqual([a.id]);
  });

  it('leaves its input in place', () => {
    const before = [...rows];
    splitRows(inbox(rows), 'all', index, null);
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

describe('listedRows', () => {
  it('lists the inbox rows, then the kept ones', () => {
    const kept = makeKeptRow({ id: 'k:one' });
    expect(ids(listedRows(makeList([a, b], { kept: [kept] })))).toEqual([a.id, b.id, kept.id]);
    const snoozed = makeSnoozedRow({ id: 's:one' });
    expect(ids(listedRows(makeList([a], { kept: [kept], snoozed: [snoozed] })))).toEqual([
      a.id,
      kept.id,
      snoozed.id,
    ]);
    expect(listedRows(makeList([a]))).toEqual([a]);
    expect(listedRows(null)).toEqual([]);
  });
});

describe('availableSplits', () => {
  it('adds Snoozed and Kept only when the list carries their rows', () => {
    expect(availableSplits(makeList([]))).toEqual(['today', 'recent', 'woke', 'all']);
    expect(availableSplits({ kept: [] })).toEqual(['today', 'recent', 'woke', 'all', 'kept']);
    expect(availableSplits({ snoozed: [] })).toEqual(['today', 'recent', 'woke', 'all', 'snoozed']);
    expect(availableSplits({ kept: [], snoozed: [] })).toEqual([
      'today',
      'recent',
      'woke',
      'all',
      'snoozed',
      'kept',
    ]);
    expect(availableSplits(null)).toEqual(['today', 'recent', 'woke', 'all']);
  });
});

describe('isSnoozed and offers', () => {
  const snoozed = makeSnoozedRow({ label: 'S' });
  const woke = makeRow({ label: 'W', woke: true, snoozed_at: '2026-10-01T09:00:00+00:00' });

  it('counts a snooze as active until it has woken, and never on a kept row', () => {
    expect(isSnoozed(snoozed)).toBe(true);
    expect(isSnoozed(woke)).toBe(false);
    expect(isSnoozed(makeKeptRow({ snoozed_at: '2026-10-01T09:00:00+00:00' }))).toBe(false);
  });

  it('offers wake and re-snooze on a snoozed row, but not keep', () => {
    expect(offers('wake', snoozed)).toBe(true);
    expect(offers('snooze', snoozed)).toBe(true);
    expect(offers('keep', snoozed)).toBe(false);
    expect(offers('keepGoing', snoozed)).toBe(false);
    expect(offers('resume', snoozed)).toBe(true);
    expect(offers('wake', woke)).toBe(false);
  });
});

describe('clientRefusal', () => {
  const kept = makeKeptRow({ label: 'K' });

  it('accepts a decision when any row passes the refusals', () => {
    expect(acceptsAny('snooze', [kept, makeRow()])).toBe(true);
    expect(acceptsAny('snooze', [kept])).toBe(false);
  });

  it('wakes only snoozed rows and keeps none of them', () => {
    const snoozed = makeSnoozedRow({ label: 'S' });
    expect(clientRefusal('wake', snoozed)).toBeNull();
    expect(clientRefusal('wake', makeRow({ label: 'L' }))).toBe('L isn’t snoozed');
    expect(
      clientRefusal('wake', makeKeptRow({ label: 'K', snoozed_at: '2026-10-01T09:00:00+00:00' })),
    ).toBe('K is kept');
    expect(clientRefusal('keep', snoozed)).toBe('S is snoozed');
    expect(clientRefusal('keep_going', snoozed)).toBe('S is snoozed');
    expect(clientRefusal('snooze', snoozed)).toBeNull();
  });

  it('returns only kept rows to the inbox', () => {
    expect(clientRefusal('unkeep', kept)).toBeNull();
    expect(clientRefusal('unkeep', makeRow({ label: 'L' }))).toBe('L isn’t kept');
  });

  it.each(['snooze', 'keep', 'keep_going'] as const)('refuses to %s a kept row', (action) => {
    expect(clientRefusal(action, kept)).toBe('K is already kept');
  });

  it('lets a kept row be archived', () => {
    expect(clientRefusal('archive', kept)).toBeNull();
  });

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
