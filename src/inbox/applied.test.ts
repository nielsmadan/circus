import { describe, expect, it } from 'vitest';
import { adoptList, markApplied } from './applied';

describe('applied', () => {
  it('keeps an id until a list that started later lands', () => {
    const applied = markApplied(new Map(), 'a', 3);
    expect([...adoptList(applied, 3)]).toEqual([['a', 3]]);
    expect([...adoptList(applied, 4)]).toEqual([]);
  });

  it('returns new maps and leaves the input alone', () => {
    const empty = new Map<string, number>();
    const marked = markApplied(empty, 'a', 1);
    expect(marked).not.toBe(empty);
    expect(empty.size).toBe(0);
    expect(adoptList(marked, 2)).not.toBe(marked);
    expect(marked.get('a')).toBe(1);
  });
});
