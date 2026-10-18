import { describe, expect, it } from 'vitest';
import { FALLBACK_VIEWPORT, ROW_HEIGHT, rowWindow, scrollToShow } from './rowWindow';

describe('rowWindow', () => {
  it('covers the visible rows plus the overscan below at the top', () => {
    expect(rowWindow(0, 640, 2000)).toEqual({
      start: 0,
      end: 18,
      padTop: 0,
      padBottom: (2000 - 18) * ROW_HEIGHT,
    });
  });

  it('starts the overscan above the first visible row', () => {
    const window = rowWindow(ROW_HEIGHT * 100, 640, 2000);
    expect(window.start).toBe(92);
    expect(window.end).toBe(118);
    expect(window.padTop).toBe(92 * ROW_HEIGHT);
  });

  it('falls back to a fixed viewport when the height is unknown', () => {
    expect(rowWindow(0, 0, 2000).end).toBe(Math.ceil(FALLBACK_VIEWPORT / ROW_HEIGHT) + 8);
  });

  it('clamps to the row count', () => {
    expect(rowWindow(0, 640, 5)).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });
    expect(rowWindow(ROW_HEIGHT * 1990, 640, 2000).end).toBe(2000);
  });

  it('keeps a 2 000-row list to at most 40 rendered rows', () => {
    const window = rowWindow(ROW_HEIGHT * 700, FALLBACK_VIEWPORT, 2000);
    expect(window.end - window.start).toBeLessThanOrEqual(40);
  });
});

describe('scrollToShow', () => {
  it('scrolls down just far enough to show a row below the viewport', () => {
    expect(scrollToShow(20, 0, 640)).toBe(21 * 64 - 640);
  });

  it('leaves a fully visible row where it is', () => {
    expect(scrollToShow(3, 0, 640)).toBe(0);
    expect(scrollToShow(12, 300, 640)).toBe(300);
  });

  it('scrolls up to the top of a row above the viewport', () => {
    expect(scrollToShow(2, 640, 640)).toBe(128);
  });
});
