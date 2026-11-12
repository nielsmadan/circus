import { describe, expect, it } from 'vitest';
import { makeRow } from '../test/fixtures';
import { folderOf, inScope, sameScope, scopeNoun, viewFor, type Scope } from './scope';

const at = (project: string | null) => makeRow({ id: `x:${project ?? 'none'}`, project });
const tree = (key: string, excluding: string | null = null): Scope => ({
  kind: 'tree',
  key,
  label: key,
  excluding,
});
const folder = (key: string): Scope => ({ kind: 'folder', key, label: key });

describe('inScope', () => {
  it('matches a folder exactly', () => {
    expect(inScope(at('/u/a/foo'), folder('/u/a/foo'), 0)).toBe(true);
    expect(inScope(at('/u/a/foo/sub'), folder('/u/a/foo'), 0)).toBe(false);
  });

  it('matches a tree node and everything under it, never a sibling sharing its prefix', () => {
    expect(inScope(at('/u/a/foo'), tree('/u/a/foo'), 0)).toBe(true);
    expect(inScope(at('/u/a/foo/sub/deep'), tree('/u/a/foo'), 0)).toBe(true);
    expect(inScope(at('/u/a/foobar'), tree('/u/a/foo'), 0)).toBe(false);
  });

  it('matches every absolute folder from the / root except the excluded home', () => {
    expect(inScope(at('/opt/src'), tree('/'), 0)).toBe(true);
    expect(inScope(at(null), tree('/'), 0)).toBe(false);
    expect(inScope(at('/opt/src'), tree('/', '/u'), 0)).toBe(true);
    expect(inScope(at('/u/wrksp/a'), tree('/', '/u'), 0)).toBe(false);
    expect(inScope(at('/uv/a'), tree('/', '/u'), 0)).toBe(true);
  });

  it('matches only folderless sessions from the unknown folder', () => {
    expect(inScope(at(null), folder('(unknown)'), 0)).toBe(true);
    expect(inScope(at(null), tree('(unknown)'), 0)).toBe(true);
    expect(inScope(at('/u/a'), tree('(unknown)'), 0)).toBe(false);
  });

  it('matches a period by last activity, start inclusive and end exclusive', () => {
    const period: Scope = {
      kind: 'period',
      key: 'day:x',
      label: 'x',
      period: 'day',
      start: 10,
      end: 20,
    };
    expect([9, 10, 19, 20].map((ms) => inScope(at('/u/a'), period, ms))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    const open: Scope = { ...period, end: null };
    expect([9, 10, 1e15].map((ms) => inScope(at('/u/a'), open, ms))).toEqual([false, true, true]);
  });

  it('treats a missing or empty folder as unknown', () => {
    expect([folderOf(at(null)), folderOf(at(''))]).toEqual(['(unknown)', '(unknown)']);
  });

  it('matches a repo by project key', () => {
    const row = makeRow({ id: 'x:r', project_key: 'github.com/acme/web' });
    expect(inScope(row, { kind: 'repo', key: 'github.com/acme/web', label: 'web' }, 0)).toBe(true);
  });
});

describe('sameScope and scopeNoun', () => {
  it('compares kind and key', () => {
    expect(sameScope(tree('/u/a'), { ...tree('/u/a'), label: 'other' })).toBe(true);
    expect(sameScope(tree('/u/a'), folder('/u/a'))).toBe(false);
    expect(sameScope(null, null)).toBe(true);
  });

  it('names what a scope covers', () => {
    const week: Scope = {
      kind: 'period',
      key: 'week:2026-10-26',
      label: 'w',
      period: 'week',
      start: 0,
      end: 1,
    };
    expect(scopeNoun({ kind: 'repo', key: 'k', label: 'k' })).toBe('repo');
    expect(scopeNoun(tree('/u'))).toBe('folder');
    expect(scopeNoun(week)).toBe('week');
    expect([viewFor(tree('/u')), viewFor(folder('/u')), viewFor(week)]).toEqual([
      'tree',
      'folders',
      'dates',
    ]);
  });
});
