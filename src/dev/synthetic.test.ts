import { describe, expect, it } from 'vitest';
import { SESSION_ROW_KEYS } from '../api/types';
import { keepEvery, snoozeEvery, syntheticRows } from './synthetic';

const NOW = Date.UTC(2026, 9, 16, 12);

describe('syntheticRows', () => {
  it('is deterministic and returns new objects', () => {
    const first = syntheticRows(50, NOW);
    const second = syntheticRows(50, NOW);
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
  });

  it('fills every SessionRow key', () => {
    syntheticRows(50, NOW).forEach((row) => {
      expect(Object.keys(row).sort()).toEqual([...SESSION_ROW_KEYS]);
    });
  });

  it('marks exactly the newest row as running', () => {
    const rows = syntheticRows(50, NOW);
    const running = rows.filter((row) => row.running === true);
    const newest = Math.max(...rows.map((row) => Date.parse(row.mtime)));
    expect(running).toHaveLength(1);
    expect(Date.parse(running[0]?.mtime ?? '')).toBe(newest);
  });

  it('carries five-field numeric fingerprints, as ringleader stamps them', () => {
    syntheticRows(50, NOW).forEach((row) => {
      expect(row.file_fingerprint).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
    });
  });

  it('uses unique ids, every fifth from codex', () => {
    const rows = syntheticRows(50, NOW);
    expect(new Set(rows.map((row) => row.id)).size).toBe(50);
    expect(rows.filter((row) => row.source === 'codex')).toHaveLength(10);
    expect(rows[4]?.id).toBe('codex:s4');
  });

  it('spreads mtimes over the last 60 days and flags recent ones', () => {
    const rows = syntheticRows(500, NOW);
    rows.forEach((row) => {
      const age = NOW - Date.parse(row.mtime);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(60 * 86_400_000);
      expect(row.in_recent).toBe(age <= 7 * 86_400_000);
      expect(row.mtime.endsWith('+00:00')).toBe(true);
    });
    expect(new Set(rows.map((row) => row.project_key)).size).toBeLessThanOrEqual(35);
  });

  it('spreads sessions over checkouts, a monorepo, plain folders and an unknown folder', () => {
    const rows = syntheticRows(500, NOW);
    const foldersOf = (key: string) =>
      new Set(rows.filter((row) => row.project_key === key).map((row) => row.project));
    expect(foldersOf('github.com/acme/proj-00')).toEqual(
      new Set(['/u/wrksp/proj-00/dev1', '/u/wrksp/proj-00/dev2']),
    );
    expect(foldersOf('github.com/acme/mono').size).toBeGreaterThan(1);
    expect(rows.find((row) => row.project === '/u/notes/proj-03')).toMatchObject({
      project_key: '/u/notes/proj-03',
      project_label: '~/notes/proj-03',
      git_project_key: null,
    });
    expect(rows.find((row) => row.project === null)).toMatchObject({ project_key: '(unknown)' });
  });
});

describe('keepEvery', () => {
  it('moves every nth row into the kept list, kept after its last activity', () => {
    const rows = syntheticRows(10, NOW);
    const { sessions, kept } = keepEvery(rows, 5, NOW);
    expect(sessions.map((row) => row.id)).toEqual(
      rows.filter((_, index) => index !== 4 && index !== 9).map((row) => row.id),
    );
    expect(kept.map((row) => row.id)).toEqual([rows[4]?.id, rows[9]?.id]);
    kept.forEach((row) => {
      expect(row).toMatchObject({ decision: 'keep', woke: false, badges: ['kept'] });
      expect(Date.parse(row.kept_at ?? '')).toBeGreaterThanOrEqual(Date.parse(row.mtime));
      expect(Date.parse(row.kept_at ?? '')).toBeLessThanOrEqual(NOW);
    });
  });
});

describe('snoozeEvery', () => {
  it('snoozes every nth inbox row that has not woken, with some snoozes open-ended', () => {
    const rows = syntheticRows(200, NOW).map((row, index) => ({ ...row, woke: index === 39 }));
    const world = snoozeEvery({ sessions: rows, kept: [], snoozed: [] }, 20, NOW);
    const picked = rows.filter((_, index) => index % 20 === 19 && index !== 39);
    expect(world.snoozed.map((row) => row.id)).toEqual(picked.map((row) => row.id));
    expect(world.sessions.map((row) => row.id)).toContain(rows[39]?.id);
    expect(world.sessions).toHaveLength(191);
    expect(world.snoozed.filter((row) => row.snoozed_until === null)).toHaveLength(1);
    const dated = world.snoozed.flatMap((row) =>
      row.snoozed_until === null ? [] : [Date.parse(row.snoozed_until)],
    );
    expect(dated).toHaveLength(8);
    expect(dated.every((ms) => ms > NOW)).toBe(true);
    world.snoozed.forEach((row) => {
      expect(row).toMatchObject({ woke: false, badges: ['snoozed'] });
    });
  });
});
