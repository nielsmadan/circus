export type Applied = ReadonlyMap<string, number>;

export function markApplied(applied: Applied, id: string, lastStartedSeq: number): Applied {
  return new Map(applied).set(id, lastStartedSeq);
}

export function adoptList(applied: Applied, landedSeq: number): Applied {
  return new Map([...applied].filter(([, seq]) => seq >= landedSeq));
}
