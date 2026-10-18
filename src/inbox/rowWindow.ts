export const ROW_HEIGHT = 64;
export const FALLBACK_VIEWPORT = 800;

export interface RowWindow {
  readonly start: number;
  readonly end: number;
  readonly padTop: number;
  readonly padBottom: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const effectiveViewport = (viewport: number): number =>
  viewport > 0 ? viewport : FALLBACK_VIEWPORT;

export function rowWindow(
  scrollTop: number,
  viewport: number,
  count: number,
  overscan = 8,
): RowWindow {
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / ROW_HEIGHT);
  const last = Math.ceil((top + effectiveViewport(viewport)) / ROW_HEIGHT);
  const start = clamp(first - overscan, 0, count);
  const end = clamp(last + overscan, start, count);
  return { start, end, padTop: start * ROW_HEIGHT, padBottom: (count - end) * ROW_HEIGHT };
}

export function scrollToShow(index: number, scrollTop: number, viewport: number): number {
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  const height = effectiveViewport(viewport);
  if (top < scrollTop) return top;
  if (bottom > scrollTop + height) return Math.max(0, bottom - height);
  return scrollTop;
}
