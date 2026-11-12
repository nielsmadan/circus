import { describe, expect, it } from 'vitest';
import { clampWidth, parseWidth, shownWidth, sidebarColumns } from './sidebarWidth';

describe('sidebar width', () => {
  it('clamps to the allowed range and rounds', () => {
    expect([100, 300.4, 900].map(clampWidth)).toEqual([192, 300, 512]);
  });

  it('reads a stored width and falls back to the default for missing or garbage values', () => {
    expect(parseWidth('320')).toBe(320);
    expect(parseWidth('4000')).toBe(512);
    expect([null, '', 'wide', 'NaN'].map(parseWidth)).toEqual([288, 288, 288, 288]);
  });

  it('caps the sidebar column at 40% of the window', () => {
    expect(sidebarColumns(300)).toBe('min(300px, 40vw) minmax(0, 1fr) minmax(0, 1.1fr)');
    expect([shownWidth(512, 1000), shownWidth(288, 1000)]).toEqual([400, 288]);
  });
});
