import { describe, expect, it, vi } from 'vitest';
import { createFlight, createSequence, createSequencedFlight, type Landed } from './coalesce';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('createFlight', () => {
  it('runs the first request and only the latest of those made while busy', async () => {
    const runs: { arg: string; done: ReturnType<typeof deferred<string>> }[] = [];
    const landed: Landed<string, string>[] = [];
    const flight = createFlight(
      (arg: string) => {
        const done = deferred<string>();
        runs.push({ arg, done });
        return done.promise;
      },
      (l) => landed.push(l),
    );
    flight.request('first');
    expect(flight.busy).toBe(true);
    expect(flight.lastStarted).toBe(1);
    flight.request('stored');
    flight.request('latest');
    expect(runs.map((r) => r.arg)).toEqual(['first']);
    runs[0]?.done.resolve('one');
    await settle();
    expect(runs.map((r) => r.arg)).toEqual(['first', 'latest']);
    expect(flight.lastStarted).toBe(2);
    runs[1]?.done.resolve('two');
    await settle();
    expect(landed).toEqual([
      { seq: 1, arg: 'first', result: { ok: true, value: 'one' } },
      { seq: 2, arg: 'latest', result: { ok: true, value: 'two' } },
    ]);
    expect(flight.busy).toBe(false);
  });

  it('lands a rejected run with a CircusError', async () => {
    const landed: Landed<number, string>[] = [];
    const flight = createFlight<number, string>(
      () => Promise.reject(new Error('nope')),
      (l) => landed.push(l),
    );
    flight.request(7);
    await settle();
    expect(landed).toEqual([
      {
        seq: 1,
        arg: 7,
        result: {
          ok: false,
          error: { kind: 'failed', message: 'Error: nope', exit_code: null, stderr_tail: null },
        },
      },
    ]);
  });

  it('keeps going after a throwing onLanded', async () => {
    const seen: number[] = [];
    const flight = createFlight(
      (arg: number) => Promise.resolve(arg),
      (l) => {
        seen.push(l.seq);
        throw new Error('listener');
      },
    );
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    flight.request(1);
    flight.request(2);
    await settle();
    expect(seen).toEqual([1, 2]);
    expect(report).toHaveBeenCalledTimes(2);
  });
});

describe('createSequence', () => {
  it('numbers runs across flights that share it while each flight keeps its own lastStarted', async () => {
    const sequence = createSequence();
    const landed: string[] = [];
    const a = createSequencedFlight(
      (arg: string) => Promise.resolve(arg),
      (l) => landed.push(`${l.arg}:${l.seq}`),
      sequence,
    );
    const b = createSequencedFlight(
      (arg: string) => Promise.resolve(arg),
      (l) => landed.push(`${l.arg}:${l.seq}`),
      sequence,
    );
    expect(sequence.lastStarted).toBe(0);
    a.request('a1');
    b.request('b1');
    a.request('a2');
    expect(sequence.lastStarted).toBe(2);
    expect(a.lastStarted).toBe(1);
    expect(b.lastStarted).toBe(2);
    await settle();
    expect(a.lastStarted).toBe(3);
    expect(sequence.lastStarted).toBe(3);
    expect(landed).toEqual(['a1:1', 'b1:2', 'a2:3']);
  });
});
