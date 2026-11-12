import { describe, expect, it } from 'vitest';
import { parseView } from './useSidebarScope';

describe('parseView', () => {
  it('restores a stored view and falls back to repos for anything else', () => {
    expect(['folders', 'tree', 'dates'].map(parseView)).toEqual(['folders', 'tree', 'dates']);
    expect([null, '', 'bogus'].map(parseView)).toEqual(['repos', 'repos', 'repos']);
  });
});
