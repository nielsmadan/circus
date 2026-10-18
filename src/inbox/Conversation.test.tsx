import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { CircusError, ListResponse, SessionRow, TailItem, TailsResponse } from '../api/types';
import { inboxListContext } from '../shortcuts/contexts';
import { ShortcutRegistryProvider } from '../shortcuts/react';
import { createFakeApi, deferred, type Deferred, type FakeApi } from '../test/fakeApi';
import { makeList, makeRow } from '../test/fixtures';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';

let harness: ShortcutHarness;
let api: FakeApi;
let held: { readonly ids: readonly string[]; readonly reply: Deferred<TailsResponse> }[];

const id = (n: number) => `claude-code:r${n}`;
const ids = (...ns: number[]) => ns.map(id);

function row(n: number, overrides: Partial<SessionRow> = {}): SessionRow {
  return makeRow({
    id: id(n),
    session_id: `r${n}`,
    label: `row ${n}`,
    mtime: new Date(Date.UTC(2026, 9, 16, 11 - n)).toISOString(),
    file_fingerprint: `fp-${n}`,
    ...overrides,
  });
}

const ROWS = Array.from({ length: 12 }, (_, n) => row(n));

function tailItem(rowFor: SessionRow, overrides: Partial<TailItem> = {}): TailItem {
  return {
    id: rowFor.id,
    text: `tail of ${rowFor.id}`,
    max_chars: 50_000,
    truncated: false,
    unavailable: null,
    mtime: rowFor.mtime,
    file_fingerprint: rowFor.file_fingerprint,
    ...overrides,
  };
}

function tailsFor(
  list: ListResponse,
  requested: readonly string[],
  overrides: Readonly<Record<string, Partial<TailItem>>> = {},
): TailsResponse {
  const byId = new Map(list.sessions.map((each) => [each.id, each]));
  return {
    version: 1,
    kind: 'tails',
    items: requested.map((each) => {
      const known = byId.get(each);
      if (known === undefined) throw new Error(`unknown id ${each}`);
      return tailItem(known, overrides[each]);
    }),
  };
}

function circusError(kind: CircusError['kind'], message: string): CircusError {
  return { kind, message, exit_code: null, stderr_tail: null };
}

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const advance = (ms = 50) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function press(code: string) {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  });
}

const listbox = () => screen.getByRole('listbox', { name: 'Sessions' });
const option = (n: number) => {
  const found = within(listbox())
    .getAllByRole('option')
    .find((each) => each.dataset.rowId === id(n));
  if (found === undefined) throw new Error(`no option for ${id(n)}`);
  return found;
};
const click = (n: number) => {
  act(() => {
    fireEvent.click(option(n));
  });
};
const conversation = () => screen.getByRole('region', { name: 'Conversation' });
const transcript = () =>
  [...conversation().querySelectorAll('pre')].map((pre) => pre.textContent).join('');
const skeleton = () => conversation().querySelector('[aria-busy="true"]');
const tailCalls = () => api.argsOf('tails').map(([requested]) => [...requested]);

async function renderInbox(list: ListResponse = makeList(ROWS)) {
  api = createFakeApi(list);
  api.setDefault('tails', (requested) => {
    const reply = deferred<TailsResponse>();
    held.push({ ids: [...requested], reply });
    return reply.promise;
  });
  render(
    <StrictMode>
      <ShortcutRegistryProvider registry={harness.registry}>
        <App api={api} />
      </ShortcutRegistryProvider>
    </StrictMode>,
  );
  await flush();
  await flush();
}

async function land(at: number, list: ListResponse = makeList(ROWS)) {
  const call = held[at];
  if (call === undefined) throw new Error(`no tails call #${at}`);
  await act(async () => {
    call.reply.resolve(tailsFor(list, call.ids));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(async () => {
  held = [];
  harness = await shortcutHarness();
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  vi.setSystemTime(new Date(2026, 9, 16, 14, 30));
});

afterEach(() => {
  harness.dispose();
  vi.useRealTimers();
});

describe('reading-pane conversation', () => {
  it('shows a skeleton, then fetches the selection and its neighbours in one call', async () => {
    await renderInbox();
    expect(skeleton()).toHaveTextContent('Loading conversation…');

    await advance();
    expect(tailCalls()).toEqual([ids(0, 1, 2, 3, 4, 5)]);

    await land(0);
    expect(transcript()).toBe(`tail of ${id(0)}`);
    expect(conversation().querySelector('pre')).toHaveTextContent(`tail of ${id(0)}`);
  });

  it('shows a prefetched tail in the same act as the keypress', async () => {
    await renderInbox();
    await advance();
    await land(0);

    press('KeyJ');
    expect(transcript()).toBe(`tail of ${id(1)}`);
    expect(api.count('tails')).toBe(1);

    await advance();
    expect(tailCalls()).toEqual([ids(0, 1, 2, 3, 4, 5), ids(6)]);
  });

  it('coalesces held-key selections into one call for the final selection', async () => {
    await renderInbox();
    await advance();
    await land(0);

    press('KeyJ');
    press('KeyJ');
    press('KeyJ');
    press('KeyJ');
    expect(api.count('tails')).toBe(1);
    expect(transcript()).toBe(`tail of ${id(4)}`);

    await advance();
    expect(tailCalls()).toEqual([ids(0, 1, 2, 3, 4, 5), ids(6, 7, 8, 9)]);
  });

  it('runs one queued call computed for the latest selection when the first lands', async () => {
    await renderInbox();
    await advance();
    expect(api.count('tails')).toBe(1);

    click(9);
    await advance();
    expect(api.count('tails')).toBe(1);
    expect(skeleton()).not.toBeNull();

    await land(0);
    expect(tailCalls()).toEqual([ids(0, 1, 2, 3, 4, 5), ids(9, 10, 8, 11, 7)]);
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByText(`tail of ${id(0)}`)).toBeNull();

    await land(1);
    expect(transcript()).toBe(`tail of ${id(9)}`);
    expect(api.count('tails')).toBe(2);
  });

  it('misses the cache for a row whose mtime changed in a new list', async () => {
    const first = makeList(ROWS);
    await renderInbox(first);
    await advance();
    await land(0);

    const changed = row(1, { mtime: new Date(Date.UTC(2026, 9, 16, 10, 30)).toISOString() });
    const next = makeList(ROWS.map((each) => (each.id === id(1) ? changed : each)));
    api.setList(next);
    act(() => harness.registry.dispatch(inboxListContext, 'rescan'));
    await flush();
    await flush();

    press('KeyJ');
    expect(skeleton()).not.toBeNull();

    await advance();
    expect(tailCalls().at(-1)).toContain(id(1));

    await land(held.length - 1, next);
    expect(transcript()).toBe(`tail of ${id(1)}`);
  });

  it('shows an unavailable conversation with its reason', async () => {
    await renderInbox();
    await advance();
    const call = held[0];
    await act(async () => {
      call?.reply.resolve(
        tailsFor(makeList(ROWS), call.ids, { [id(0)]: { unavailable: 'transcript not found' } }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(conversation()).toHaveTextContent('Conversation unavailable: transcript not found');
  });

  it('shows a row whose id circus could not pass to rl as unavailable, and its neighbours', async () => {
    await renderInbox();
    await advance();
    const call = held[0];
    await act(async () => {
      const full = tailsFor(makeList(ROWS), call?.ids ?? []);
      call?.reply.resolve({ ...full, items: full.items.filter((item) => item.id !== id(0)) });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(conversation()).toHaveTextContent(
      'Conversation unavailable: circus cannot pass this session id to rl',
    );
    expect(screen.queryByText(/May be out of date/)).toBeNull();
    press('KeyJ');
    expect(transcript()).toBe(`tail of ${id(1)}`);
  });

  it('names the export command for a truncated tail', async () => {
    await renderInbox();
    await advance();
    const call = held[0];
    await act(async () => {
      call?.reply.resolve(tailsFor(makeList(ROWS), call.ids, { [id(0)]: { truncated: true } }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(conversation()).toHaveTextContent(
      'Showing the last 50,000 characters — rl data export r0 writes the whole conversation',
    );
  });

  it('shows a failed call on the selected row and re-requests it when selected again', async () => {
    await renderInbox();
    await advance();
    await land(0);

    click(11);
    await advance();
    expect(tailCalls().at(-1)).toEqual(ids(11, 10, 9));
    await act(async () => {
      held[1]?.reply.reject(circusError('timeout', 'rl gui tail timed out'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(conversation()).toHaveTextContent(
      'Couldn’t load the conversation: rl gui tail timed out',
    );

    click(0);
    expect(transcript()).toBe(`tail of ${id(0)}`);
    await advance();

    click(11);
    await advance();
    expect(tailCalls().at(-1)).toContain(id(11));
  });

  it('renders a long tail as content-visibility chunks that join back to the text', async () => {
    await renderInbox();
    await advance();
    const text = Array.from(
      { length: 250 },
      (_, n) => `${String(n).padStart(4, '0')} ${'x'.repeat(74)}\n`,
    ).join('');
    expect(text).toHaveLength(20_000);
    const call = held[0];
    await act(async () => {
      call?.reply.resolve(tailsFor(makeList(ROWS), call.ids, { [id(0)]: { text } }));
      await vi.advanceTimersByTimeAsync(0);
    });

    const chunks = [...conversation().querySelectorAll('pre')];
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.map((pre) => pre.textContent).join('')).toBe(text);
    chunks.slice(0, -1).forEach((pre) => expect(pre.style.contentVisibility).toBe('auto'));
    expect(chunks.at(-1)?.style.contentVisibility).toBe('');
  });

  it('keeps the old error hidden while the retry for the selected row is in flight', async () => {
    await renderInbox();
    await advance();
    await land(0);

    click(11);
    await advance();
    await act(async () => {
      held[1]?.reply.reject(circusError('timeout', 'rl gui tail timed out'));
      await vi.advanceTimersByTimeAsync(0);
    });
    click(0);
    await advance();
    click(11);
    await advance();

    expect(held).toHaveLength(3);
    expect(skeleton()).not.toBeNull();
    expect(conversation()).not.toHaveTextContent('Couldn’t load');
  });

  it('computes the ids when a queued call runs, not when it was requested', async () => {
    await renderInbox();
    await advance();
    click(4);
    await advance();
    await act(async () => {
      held[0]?.reply.reject(circusError('timeout', 'rl gui tail timed out'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(tailCalls().at(-1)).toEqual(ids(4, 5, 3, 6, 7, 2, 8, 9));
  });

  it('misses the cache for a row whose fingerprint changed in a new list', async () => {
    await renderInbox();
    await advance();
    await land(0);

    const changed = row(1, { file_fingerprint: 'fp-new' });
    const next = makeList(ROWS.map((each) => (each.id === id(1) ? changed : each)));
    api.setList(next);
    act(() => harness.registry.dispatch(inboxListContext, 'rescan'));
    await flush();
    await flush();

    press('KeyJ');
    expect(skeleton()).not.toBeNull();
  });

  it('shows a landed tail whose key no longer matches its row instead of a skeleton', async () => {
    await renderInbox();
    await advance();
    const call = held[0];
    await act(async () => {
      call?.reply.resolve(
        tailsFor(makeList(ROWS), call.ids, { [id(0)]: { mtime: null, file_fingerprint: null } }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(transcript()).toBe(`tail of ${id(0)}`);
    expect(conversation()).toHaveTextContent('May be out of date');
  });

  it('marks an older tail as out of date and shows its failed refetch', async () => {
    await renderInbox();
    await advance();
    const changed = row(0, { mtime: new Date(Date.UTC(2026, 9, 16, 11, 30)).toISOString() });
    const next = makeList(ROWS.map((each) => (each.id === id(0) ? changed : each)));
    api.setList(next);
    act(() => harness.registry.dispatch(inboxListContext, 'rescan'));
    await flush();
    await flush();
    await advance();

    await land(0);
    await advance();
    expect(transcript()).toBe(`tail of ${id(0)}`);
    expect(conversation()).toHaveTextContent('May be out of date');
    expect(tailCalls().at(-1)).toContain(id(0));

    await act(async () => {
      held.at(-1)?.reply.reject(circusError('timeout', 'rl gui tail timed out'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(conversation()).toHaveTextContent(
      'Couldn’t refresh the conversation: rl gui tail timed out',
    );
    expect(transcript()).toBe(`tail of ${id(0)}`);
  });

  it('measures select-to-pane once per keypress when the selected tail is replaced', async () => {
    performance.clearMarks();
    performance.clearMeasures();
    await renderInbox();
    await advance();
    await land(0);
    press('KeyJ');
    await advance();
    await land(1);
    expect(performance.getEntriesByName(`select-to-pane:${id(1)}`, 'measure')).toHaveLength(1);

    const changed = row(1, { mtime: new Date(Date.UTC(2026, 9, 16, 10, 30)).toISOString() });
    const next = makeList(ROWS.map((each) => (each.id === id(1) ? changed : each)));
    api.setList(next);
    act(() => harness.registry.dispatch(inboxListContext, 'rescan'));
    await flush();
    await flush();
    await advance();
    await land(held.length - 1, next);
    await advance();

    expect(transcript()).toBe(`tail of ${id(1)}`);
    expect(performance.getEntriesByName(`select-to-pane:${id(1)}`, 'measure')).toHaveLength(1);
  });

  it('prefetches the new neighbours when a search changes the visible order', async () => {
    const rows = ROWS.map((each, n) =>
      n >= 1 && n <= 5 ? { ...each, label: `other ${n}` } : each,
    );
    await renderInbox(makeList(rows));
    await advance();
    await land(0, makeList(rows));
    expect(api.count('tails')).toBe(1);

    act(() => {
      fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'row' } });
    });
    await advance();

    expect(tailCalls().at(-1)).toEqual(ids(6, 7, 8, 9, 10));
  });
});
