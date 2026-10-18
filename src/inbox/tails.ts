import { TAIL_MAX_IDS, type SessionRow, type TailItem } from '../api/types';

export const TAIL_CACHE_CAPACITY = 64;
export const PREFETCH_OFFSETS: readonly number[] = Object.freeze([0, 1, -1, 2, 3, -2, 4, 5]);

export function tailKey(id: string, mtime: string | null, fingerprint: string | null): string {
  return `${id}|${mtime ?? ''}|${fingerprint ?? ''}`;
}

function rowKey(row: SessionRow): string {
  return tailKey(row.id, row.mtime, row.file_fingerprint);
}

export class TailLru {
  private readonly capacity: number;
  private readonly items = new Map<string, TailItem>();

  constructor(capacity: number = TAIL_CACHE_CAPACITY) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.size;
  }

  get(row: SessionRow): TailItem | undefined {
    const key = rowKey(row);
    const item = this.items.get(key);
    if (item === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, item);
    return item;
  }

  peek(row: SessionRow): TailItem | undefined {
    return this.items.get(rowKey(row));
  }

  put(item: TailItem): void {
    const key = tailKey(item.id, item.mtime, item.file_fingerprint);
    this.items.delete(key);
    this.items.set(key, item);
    for (const oldest of this.items.keys()) {
      if (this.items.size <= this.capacity) break;
      this.items.delete(oldest);
    }
  }

  retainOnly(rows: readonly SessionRow[]): void {
    const keep = new Set(rows.map(rowKey));
    [...this.items.keys()].filter((key) => !keep.has(key)).forEach((key) => this.items.delete(key));
  }
}

export function prefetchIds(
  shown: readonly SessionRow[],
  index: number,
  cached: (row: SessionRow) => boolean,
  inFlight: ReadonlySet<string>,
): string[] {
  if (index < 0) return [];
  const ids = PREFETCH_OFFSETS.map((offset) => shown[index + offset])
    .filter((row): row is SessionRow => row !== undefined)
    .filter((row) => !inFlight.has(row.id) && !cached(row))
    .map((row) => row.id);
  return [...new Set(ids)].slice(0, TAIL_MAX_IDS);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function chunkTail(text: string, size = 4096): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= size) {
      chunks.push(text.slice(start));
      break;
    }
    const newline = text.lastIndexOf('\n', start + size - 1);
    const hardEnd = start + size;
    const splitsPair = hardEnd - 1 > start && isHighSurrogate(text.charCodeAt(hardEnd - 1));
    const end = newline >= start ? newline + 1 : splitsPair ? hardEnd - 1 : hardEnd;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
