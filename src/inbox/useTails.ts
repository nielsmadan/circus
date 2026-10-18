import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CircusApi } from '../api/client';
import type { CircusError, SessionRow, TailItem, TailsResponse } from '../api/types';
import { createFlight, type Flight, type Landed } from './coalesce';
import { hasSelectMark, markPane } from './perfMarks';
import { missingTails, prefetchIds, TailLru } from './tails';

interface Batch {
  readonly ids: readonly string[];
  readonly response: TailsResponse | null;
}

interface Failure {
  readonly ids: readonly string[];
  readonly error: CircusError;
}

interface Schedule {
  pending: boolean;
  frame: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TailView {
  readonly item: TailItem | undefined;
  readonly error: CircusError | null;
}

function afterPaint(run: () => void, schedule: Schedule): void {
  const later = () => {
    schedule.frame = null;
    schedule.timer = setTimeout(() => {
      schedule.timer = null;
      run();
    }, 0);
  };
  if (typeof requestAnimationFrame === 'function') schedule.frame = requestAnimationFrame(later);
  else later();
}

function cancel(schedule: Schedule): void {
  if (schedule.frame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(schedule.frame);
  }
  if (schedule.timer !== null) clearTimeout(schedule.timer);
  schedule.pending = false;
  schedule.frame = null;
  schedule.timer = null;
}

export function useTails(
  api: CircusApi,
  shown: readonly SessionRow[],
  positions: ReadonlyMap<string, number>,
  selected: SessionRow | null,
  sessions: readonly SessionRow[] | null,
): TailView {
  const [lru] = useState(() => new TailLru());
  const [, setTick] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const shownRef = useRef(shown);
  const positionsRef = useRef(positions);
  const selectedIdRef = useRef<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const schedule = useRef<Schedule>({ pending: false, frame: null, timer: null });
  const apiRef = useRef(api);
  const orphans = useRef(new Map<string, TailItem>());
  const running = useRef<readonly string[]>([]);
  const paneMarked = useRef(false);

  const selectedId = selected?.id ?? null;
  useLayoutEffect(() => {
    shownRef.current = shown;
    positionsRef.current = positions;
    selectedIdRef.current = selectedId;
    apiRef.current = api;
  });

  const [flight] = useState<Flight<string>>(() =>
    createFlight<string, Batch>(
      (id) => {
        const at = positionsRef.current.get(id) ?? -1;
        const ids = prefetchIds(
          shownRef.current,
          at,
          (row) => lru.peek(row) !== undefined,
          inFlight.current,
        );
        running.current = ids;
        if (ids.length === 0) return Promise.resolve({ ids, response: null });
        ids.forEach((each) => inFlight.current.add(each));
        setFailure((current) => {
          if (current === null) return current;
          const left = current.ids.filter((each) => !ids.includes(each));
          if (left.length === current.ids.length) return current;
          return left.length === 0 ? null : { ...current, ids: left };
        });
        return apiRef.current.tails(ids).then((response) => ({ ids, response }));
      },
      (landed: Landed<string, Batch>) => {
        const ids = running.current;
        running.current = [];
        ids.forEach((each) => inFlight.current.delete(each));
        if (landed.result.ok) {
          const { response } = landed.result.value;
          if (response === null) return;
          const rowOf = (id: string) => {
            const at = positionsRef.current.get(id);
            return at === undefined ? undefined : shownRef.current[at];
          };
          const requested = landed.result.value.ids
            .map(rowOf)
            .filter((row): row is SessionRow => row !== undefined);
          [...response.items, ...missingTails(requested, response.items)].forEach((item) => {
            lru.put(item);
            const row = rowOf(item.id);
            if (row !== undefined && lru.peek(row) === undefined)
              orphans.current.set(item.id, item);
            else orphans.current.delete(item.id);
          });
          setFailure(null);
        } else {
          setFailure({ ids, error: landed.result.error });
        }
        setTick((tick) => tick + 1);
      },
    ),
  );

  useEffect(() => {
    const current = schedule.current;
    return () => cancel(current);
  }, []);

  useEffect(() => {
    if (sessions === null) return;
    lru.retainOnly(sessions);
    const known = new Set(sessions.map((each) => each.id));
    [...orphans.current.keys()]
      .filter((each) => !known.has(each))
      .forEach((each) => orphans.current.delete(each));
  }, [lru, sessions]);

  useEffect(() => {
    if (selected !== null) lru.get(selected);
    const current = schedule.current;
    if (selectedId === null || current.pending) return;
    current.pending = true;
    afterPaint(() => {
      current.pending = false;
      const id = selectedIdRef.current;
      if (id !== null) flight.request(id);
    }, current);
  }, [selected, selectedId, sessions, shown, flight, lru]);

  const cached = selected === null ? undefined : lru.peek(selected);
  const item = cached ?? (selected === null ? undefined : orphans.current.get(selected.id));
  const error =
    cached === undefined &&
    failure !== null &&
    selectedId !== null &&
    failure.ids.includes(selectedId)
      ? failure.error
      : null;

  useEffect(
    () => () => {
      paneMarked.current = false;
    },
    [selectedId],
  );

  useEffect(() => {
    if (paneMarked.current || selectedId === null || item === undefined) return undefined;
    if (!hasSelectMark(selectedId) || typeof requestAnimationFrame !== 'function') return undefined;
    const frame = requestAnimationFrame(() => {
      paneMarked.current = true;
      markPane(selectedId);
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, item]);

  return { item, error };
}
