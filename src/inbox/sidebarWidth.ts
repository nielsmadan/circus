export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 192;
export const MAX_SIDEBAR_WIDTH = 512;
export const SIDEBAR_STEP = 16;
const VIEWPORT_SHARE = 0.4;

export function clampWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH));
}

export function parseWidth(raw: string | null): number {
  const width = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(width) ? clampWidth(width) : DEFAULT_SIDEBAR_WIDTH;
}

export function widthCap(viewport: number): number {
  return Math.floor(viewport * VIEWPORT_SHARE);
}

export function shownWidth(width: number, viewport: number): number {
  return Math.min(width, widthCap(viewport));
}

export function sidebarColumns(width: number): string {
  return `min(${width}px, ${VIEWPORT_SHARE * 100}vw) minmax(0, 1fr) minmax(0, 1.1fr)`;
}
