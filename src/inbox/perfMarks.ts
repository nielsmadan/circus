const canMark = (): boolean =>
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function' &&
  typeof performance.measure === 'function';

export function hasSelectMark(id: string): boolean {
  if (!import.meta.env.DEV || !canMark()) return false;
  try {
    return performance.getEntriesByName(`select:${id}`, 'mark').length > 0;
  } catch {
    return false;
  }
}

export function markSelect(id: string): void {
  if (!import.meta.env.DEV || !canMark()) return;
  try {
    performance.clearMarks(`select:${id}`);
    performance.mark(`select:${id}`);
  } catch {
    // a dev-only measurement must never break selection
  }
}

export function clearSelect(id: string): void {
  if (!import.meta.env.DEV || !canMark()) return;
  try {
    performance.clearMarks(`select:${id}`);
  } catch {
    // a dev-only measurement must never break selection
  }
}

export function markPaint(id: string): void {
  if (!import.meta.env.DEV || !canMark()) return;
  try {
    performance.mark(`paint:${id}`);
    performance.measure(`select-to-paint:${id}`, `select:${id}`, `paint:${id}`);
    performance.clearMarks(`paint:${id}`);
  } catch {
    // the select mark may already be gone
  }
}

export function markPane(id: string): void {
  if (!import.meta.env.DEV || !canMark()) return;
  try {
    performance.mark(`pane:${id}`);
    performance.measure(`select-to-pane:${id}`, `select:${id}`, `pane:${id}`);
    performance.clearMarks(`pane:${id}`);
  } catch {
    // the select mark may already be gone
  }
}
