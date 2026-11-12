import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_STEP,
  clampWidth,
  shownWidth,
  widthCap,
} from './sidebarWidth';
import { useViewportWidth } from './useSidebarWidth';

export interface SplitterProps {
  readonly width: number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  last: number;
}

const KEY_DELTA: ReadonlyMap<string, number> = new Map([
  ['ArrowLeft', -SIDEBAR_STEP],
  ['ArrowRight', SIDEBAR_STEP],
]);

const RESIZING = 'circus-resizing';

export const Splitter = memo(function Splitter({
  width,
  onPreview,
  onCommit,
}: SplitterProps): ReactElement {
  const drag = useRef<Drag | null>(null);
  const viewport = useViewportWidth();
  const shown = shownWidth(width, viewport);

  useEffect(() => () => document.body.classList.remove(RESIZING), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startWidth = clampWidth(shown);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      last: startWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add(RESIZING);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const next = clampWidth(current.startWidth + event.clientX - current.startX);
    if (next === current.last) return;
    current.last = next;
    onPreview(next);
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    document.body.classList.remove(RESIZING);
    if (current.last !== current.startWidth) onCommit(current.last);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = KEY_DELTA.get(event.key);
    if (delta === undefined) return;
    event.preventDefault();
    onCommit(shown + delta);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={shown}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={Math.min(MAX_SIDEBAR_WIDTH, widthCap(viewport))}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(DEFAULT_SIDEBAR_WIDTH)}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-blue-500/30 focus-visible:bg-blue-500/50"
    />
  );
});
