import { describe, expect, it } from 'vitest';
import type { SessionRow, TailItem } from '../api/types';
import { makeRow } from '../test/fixtures';
import { TailLru, chunkTail, prefetchIds, tailKey } from './tails';

function itemFor(row: SessionRow, text = 'tail'): TailItem {
  return {
    id: row.id,
    text,
    max_chars: 50_000,
    truncated: false,
    unavailable: null,
    mtime: row.mtime,
    file_fingerprint: row.file_fingerprint,
  };
}

const rowA = makeRow({ id: 'claude-code:a' });
const rowB = makeRow({ id: 'claude-code:b' });
const rowC = makeRow({ id: 'claude-code:c' });

describe('tailKey', () => {
  it('joins id, mtime and fingerprint', () => {
    expect(tailKey('claude-code:a', null, 'fp')).toBe('claude-code:a||fp');
  });
});

describe('TailLru', () => {
  it('evicts the least recently used entry', () => {
    const lru = new TailLru(2);
    lru.put(itemFor(rowA));
    lru.put(itemFor(rowB));
    expect(lru.get(rowA)?.id).toBe(rowA.id);
    lru.put(itemFor(rowC));
    expect(lru.size).toBe(2);
    expect(lru.peek(rowA)?.id).toBe(rowA.id);
    expect(lru.peek(rowC)?.id).toBe(rowC.id);
    expect(lru.peek(rowB)).toBeUndefined();
  });

  it('peek leaves the recency order alone', () => {
    const lru = new TailLru(2);
    lru.put(itemFor(rowA));
    lru.put(itemFor(rowB));
    lru.peek(rowA);
    lru.put(itemFor(rowC));
    expect(lru.peek(rowA)).toBeUndefined();
    expect(lru.peek(rowB)?.id).toBe(rowB.id);
  });

  it('misses a row whose mtime changed since the tail was read', () => {
    const lru = new TailLru();
    lru.put(itemFor(rowA));
    expect(lru.get({ ...rowA, mtime: '2026-10-17T00:00:00+00:00' })).toBeUndefined();
  });

  it('retains exactly the entries that match a given row', () => {
    const lru = new TailLru();
    lru.put(itemFor(rowA));
    lru.put(itemFor(rowB));
    lru.put(itemFor(rowC));
    lru.retainOnly([rowB, { ...rowC, file_fingerprint: 'changed' }]);
    expect(lru.size).toBe(1);
    expect(lru.peek(rowB)?.id).toBe(rowB.id);
  });
});

describe('prefetchIds', () => {
  const rows10 = Array.from({ length: 10 }, (_, i) => makeRow({ id: `claude-code:r${i}` }));
  const idsAt = (...indices: number[]) => indices.map((i) => `claude-code:r${i}`);

  it('starts with the selected row and its following neighbours at the top', () => {
    expect(prefetchIds(rows10, 0, () => false, new Set())).toEqual(idsAt(0, 1, 2, 3, 4, 5));
  });

  it('takes nearest neighbours in offset order and skips out-of-range rows', () => {
    expect(prefetchIds(rows10, 5, () => false, new Set())).toEqual(idsAt(5, 6, 4, 7, 8, 3, 9));
  });

  it('skips cached rows and ids in flight', () => {
    const cached = (row: SessionRow) => row.id === 'claude-code:r6';
    expect(prefetchIds(rows10, 5, cached, new Set(['claude-code:r4']))).toEqual(
      idsAt(5, 7, 8, 3, 9),
    );
  });

  it('returns nothing without a selection', () => {
    expect(prefetchIds(rows10, -1, () => false, new Set())).toEqual([]);
  });
});

describe('chunkTail', () => {
  it('cuts after the last newline and joins back to the text', () => {
    const line = `${'x'.repeat(79)}\n`;
    const text = line.repeat(250);
    const chunks = chunkTail(text, 4096);
    expect(chunks.join('')).toBe(text);
    chunks.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.endsWith('\n')).toBe(true);
    });
  });

  it('hard-cuts text without newlines', () => {
    expect(chunkTail('y'.repeat(10_000), 4096).map((chunk) => chunk.length)).toEqual([
      4096, 4096, 1808,
    ]);
  });

  it('does not split a surrogate pair at a hard cut', () => {
    const text = `${'y'.repeat(4095)}😀${'z'.repeat(10)}`;
    const chunks = chunkTail(text, 4096);
    expect(chunks.join('')).toBe(text);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4095, 12]);
  });

  it('returns no chunks for empty text', () => {
    expect(chunkTail('')).toEqual([]);
  });
});
