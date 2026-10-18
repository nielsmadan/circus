import { describe, expect, it } from 'vitest';
import { SESSION_ROW_KEYS } from '../api/types';
import { syntheticRows } from './synthetic';

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
});
