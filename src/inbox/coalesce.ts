import { toCircusError, type CircusError } from '../api/types';

export interface Landed<A, T> {
  readonly seq: number;
  readonly arg: A;
  readonly result:
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CircusError };
}

export interface Flight<A> {
  request(arg: A): void;
  readonly busy: boolean;
  readonly lastStarted: number;
}

export interface Sequence {
  next(): number;
  readonly lastStarted: number;
}

export function createSequence(): Sequence {
  let lastStarted = 0;
  return {
    next() {
      lastStarted += 1;
      return lastStarted;
    },
    get lastStarted() {
      return lastStarted;
    },
  };
}

export function createFlight<A, T>(
  run: (arg: A) => Promise<T>,
  onLanded: (landed: Landed<A, T>) => void,
): Flight<A> {
  return createSequencedFlight(run, onLanded, createSequence());
}

export function createSequencedFlight<A, T>(
  run: (arg: A) => Promise<T>,
  onLanded: (landed: Landed<A, T>) => void,
  sequence: Sequence,
): Flight<A> {
  let lastStarted = 0;
  let busy = false;
  let next: { readonly arg: A } | null = null;

  function start(arg: A): void {
    const seq = sequence.next();
    lastStarted = seq;
    busy = true;
    void new Promise<T>((resolve) => resolve(run(arg)))
      .then(
        (value): Landed<A, T>['result'] => ({ ok: true, value }),
        (error: unknown): Landed<A, T>['result'] => ({ ok: false, error: toCircusError(error) }),
      )
      .then((result) => {
        try {
          onLanded({ seq, arg, result });
        } catch (error) {
          console.error(error);
        } finally {
          busy = false;
          const queued = next;
          next = null;
          if (queued !== null) start(queued.arg);
        }
      });
  }

  return {
    request(arg) {
      if (busy) {
        next = { arg };
        return;
      }
      start(arg);
    },
    get busy() {
      return busy;
    },
    get lastStarted() {
      return lastStarted;
    },
  };
}
