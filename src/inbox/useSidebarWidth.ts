import { useCallback, useState, useSyncExternalStore } from 'react';
import { readStored, writeStored } from '../storage';
import { clampWidth, parseWidth } from './sidebarWidth';

const WIDTH_KEY = 'circus.sidebar.width';

export function useSidebarWidth(): readonly [number, (width: number) => void] {
  const [width, setWidth] = useState(() => parseWidth(readStored(WIDTH_KEY)));
  const commit = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    writeStored(WIDTH_KEY, String(clamped));
  }, []);
  return [width, commit];
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

const viewportWidth = () => window.innerWidth;

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, viewportWidth);
}
