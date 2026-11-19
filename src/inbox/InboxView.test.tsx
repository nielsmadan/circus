import { cleanup, act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { AgentInfo, CircusError, ListResponse, NextStep } from '../api/types';
import { ShortcutKitProvider, useShortcuts } from '@shortcutkit/react';
import { inboxListContext } from '../shortcuts/contexts';
import {
  createFakeApi,
  NATIVE_INFO,
  okOutcome,
  type Deferred,
  type FakeApi,
} from '../test/fakeApi';
import { makeHome, makeKeptRow, makeList, makeRow, makeStep } from '../test/fixtures';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { scrollToShow } from './rowWindow';

vi.mock('@shortcutkit/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@shortcutkit/react')>();
  return { ...original, useShortcuts: vi.fn(original.useShortcuts) };
});

let harness: ShortcutHarness;
let api: FakeApi;

const parser = makeRow({
  id: 'claude-code:p',
  session_id: 'p',
  label: 'fix parser',
  mtime: '2026-10-15T12:00:00+00:00',
  project: '/u/work/proj-01',
  project_short: '…/work/proj-01',
  project_key: '/u/work/proj-01',
  project_label: 'proj-01',
  what_it_is: 'Parser rewrite for the export',
  git_branch: 'feat/parser',
  file_fingerprint: 'fp-p',
});
const login = makeRow({
  id: 'claude-code:l',
  session_id: 'l',
  label: 'fix flaky login',
  mtime: '2026-10-14T12:00:00+00:00',
  file_fingerprint: 'fp-l',
});
const docs = makeRow({
  id: 'codex:d',
  source: 'codex',
  agent: 'codex',
  session_id: 'd',
  label: 'docs pass',
  mtime: '2026-10-13T12:00:00+00:00',
  project: '/u/work/proj-01',
  project_short: '…/work/proj-01',
  project_key: '/u/work/proj-01',
  project_label: 'proj-01',
  file_fingerprint: 'fp-d',
});
const wokeNewer = makeRow({
  id: 'claude-code:w1',
  session_id: 'w1',
  label: 'woke newer',
  mtime: '2026-09-01T12:00:00+00:00',
  in_recent: false,
  woke: true,
});
const wokeOlder = makeRow({
  id: 'claude-code:w2',
  session_id: 'w2',
  label: 'woke older',
  mtime: '2026-08-01T12:00:00+00:00',
  in_recent: false,
  woke: true,
});
const ROWS = [docs, login, wokeNewer, parser, wokeOlder];

function circusError(kind: CircusError['kind'], message: string): CircusError {
  return { kind, message, exit_code: null, stderr_tail: null };
}

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function press(code: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function renderInbox(
  list: ListResponse = makeList(ROWS),
  setup: (fake: FakeApi) => void = () => undefined,
) {
  api = createFakeApi(list);
  setup(api);
  render(
    <ShortcutKitProvider registry={harness.registry}>
      <App api={api} />
    </ShortcutKitProvider>,
  );
  await flush();
  await flush();
}

const type = (input: HTMLElement, value: string) => {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
};
const click = (element: HTMLElement, init: MouseEventInit = {}) => {
  act(() => {
    fireEvent.click(element, init);
  });
};
const search = () => screen.getByRole('searchbox', { name: 'Search sessions' });
const listbox = () => screen.getByRole('listbox', { name: 'Sessions' });
const shownIds = () =>
  within(listbox())
    .queryAllByRole('option')
    .map((option) => option.dataset.rowId);
const selectedId = () => {
  const domId = listbox().getAttribute('aria-activedescendant');
  return domId === null ? null : (document.getElementById(domId)?.dataset.rowId ?? null);
};
const pane = () => screen.getByRole('region', { name: 'Reading pane' });
const paneTitle = () => within(pane()).getByRole('heading').textContent;
const field = (name: string) =>
  within(pane()).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
const statusBar = () => screen.getByRole('status', { name: 'Inbox status' });
const decideActions = () => api.argsOf('decide').map(([request]) => request.action);

beforeEach(async () => {
  harness = await shortcutHarness();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 16, 14, 30));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('InboxView list and reading pane', () => {
  it('shows Recent rows newest first and the first row in the reading pane', async () => {
    await renderInbox();
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(selectedId()).toBe(parser.id);
    expect(paneTitle()).toBe('fix parser');
    expect(field('Project')).toBe('…/work/proj-01');
    expect(field('Agent')).toBe('claude');
    expect(field('Status')).toBe('unclassified');
    expect(field('What it is')).toBe('Parser rewrite for the export');
    expect(field('Last prompt')).toBe('—');
    expect(field('Branch')).toBe('feat/parser');
    expect(field('Session')).toBe('p');
    expect(field('Size')).toBe('4.0KB');
    expect(field('Messages')).toBe('4');
    expect(field('Activity')).toBe('6d ago');
    expect(field('Parked')).toBe('—');
    expect(screen.getByRole('tab', { name: /Recent 3/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves the selection with j, k and the arrow keys in the same act', async () => {
    await renderInbox();
    press('KeyJ');
    expect(selectedId()).toBe(login.id);
    expect(paneTitle()).toBe('fix flaky login');
    press('KeyK');
    expect(paneTitle()).toBe('fix parser');
    press('ArrowDown');
    expect(paneTitle()).toBe('fix flaky login');
    press('ArrowUp');
    press('KeyK');
    expect(selectedId()).toBe(parser.id);
  });

  it('points aria-activedescendant at the selected option', async () => {
    await renderInbox();
    press('KeyJ');
    const option = within(listbox()).getByRole('option', { selected: true });
    expect(option.id).not.toBe('');
    expect(listbox()).toHaveAttribute('aria-activedescendant', option.id);
  });

  it('does not re-render the reading-pane action buttons on j', async () => {
    const shortcuts = vi.mocked(useShortcuts);
    shortcuts.mockClear();
    await renderInbox();
    const actions = [
      'harvestArchive',
      'archive',
      'delete',
      'snooze',
      'keep',
      'keepGoing',
      'resume',
    ];
    const buttonRenders = () =>
      shortcuts.mock.calls
        .filter(([context, action]) => context === inboxListContext && actions.includes(action))
        .map(([, action]) => action);
    const initial = buttonRenders();
    expect(new Set(initial)).toEqual(new Set(actions));
    press('KeyJ');
    expect(selectedId()).toBe(login.id);
    expect(buttonRenders()).toEqual(initial);
  });

  it('scrolls the windowed list to keep the selection in view', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      makeRow({
        id: `claude-code:n${i}`,
        session_id: `n${i}`,
        label: `row ${i}`,
        mtime: new Date(Date.UTC(2026, 9, 16, 12) - i * 60_000).toISOString(),
      }),
    );
    await renderInbox(makeList(many));
    expect(within(listbox()).getAllByRole('option').length).toBeLessThanOrEqual(40);
    for (let i = 0; i < 30; i += 1) press('KeyJ');
    expect(selectedId()).toBe('claude-code:n30');
    expect(paneTitle()).toBe('row 30');
    expect(listbox().scrollTop).toBe(scrollToShow(30, 0, 0));
    expect(listbox().scrollTop).toBeGreaterThan(0);
  });

  it('paints from the cached list with a chip until the live list lands', async () => {
    const held: { list?: Deferred<ListResponse> } = {};
    await renderInbox(makeList(ROWS), (fake) => {
      fake.setDefault('cachedList', () => Promise.resolve(makeList([parser, login, docs])));
      held.list = fake.defer('list');
      fake.defer('scan');
    });
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(screen.getByText('Cached · refreshing…')).toBeInTheDocument();
    api.setList(makeList([parser, login]));
    held.list?.resolve(makeList([parser, login]));
    await flush();
    expect(shownIds()).toEqual([parser.id, login.id]);
    expect(screen.queryByText('Cached · refreshing…')).toBeNull();
  });

  it('shows the per-split empty states and the search empty state', async () => {
    await renderInbox(makeList([]));
    expect(screen.getByText('Nothing from the last 7 days is waiting')).toBeInTheDocument();
    press('Tab');
    expect(screen.getByText('No snoozed sessions have woken up')).toBeInTheDocument();
    press('Tab');
    expect(screen.getByText('Inbox zero')).toBeInTheDocument();
    press('Slash');
    type(search(), 'zzz');
    expect(screen.getByText('No sessions match “zzz”')).toBeInTheDocument();
  });

  it('shows a snooze in the reading pane only while one is set', async () => {
    const stale = makeRow({ id: 'claude-code:st', snoozed_until: '2026-10-20T09:00:00+00:00' });
    const snoozed = makeRow({
      id: 'claude-code:sn',
      mtime: '2026-10-09T12:00:00+00:00',
      snoozed_at: '2026-10-11T09:00:00+00:00',
      snoozed_until: '2026-10-20T09:00:00+00:00',
    });
    await renderInbox(makeList([stale, snoozed]));
    expect(field('Parked')).toBe('—');
    press('KeyJ');
    expect(field('Parked')).toMatch(/^snoozed until /);
  });
});

describe('InboxView decisions', () => {
  it('archives with ⇧E: hides the row, selects the next and sends after 4 s', async () => {
    await renderInbox();
    press('KeyE', { shiftKey: true });
    expect(shownIds()).toEqual([login.id, docs.id]);
    expect(selectedId()).toBe(login.id);
    expect(screen.getByText('Archive “fix parser”')).toBeInTheDocument();
    await advance(3_999);
    expect(api.count('decide')).toBe(0);
    await advance(1);
    expect(api.decideRequest(0)).toEqual({
      action: 'archive',
      id: parser.id,
      mtime: parser.mtime,
      fingerprint: 'fp-p',
      until: null,
    });
  });

  it('harvests with e, shows it in the status bar and restores an empty harvest', async () => {
    await renderInbox();
    const harvest = api.defer('decide');
    press('KeyE');
    await advance(4_000);
    expect(api.decideRequest(0).action).toBe('harvest');
    expect(statusBar()).toHaveTextContent('Harvesting 1…');
    harvest.resolve(
      okOutcome(api.decideRequest(0), { status: 'empty', wrote: false, message: 'empty' }),
    );
    await flush();
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(
      screen.getByText(
        'Nothing worth harvesting in “fix parser” — ⇧E archives it without a harvest',
      ),
    ).toBeInTheDocument();
    expect(statusBar()).toHaveTextContent('');
  });

  it('deletes with ⇧3 after 10 s, and z undoes it before then', async () => {
    await renderInbox();
    press('Digit3', { shiftKey: true });
    expect(screen.getByText('Deleting “fix parser” in 10 s')).toBeInTheDocument();
    expect(statusBar()).toHaveTextContent('1 waiting (z to undo)');
    await advance(5_000);
    expect(selectedId()).toBe(login.id);
    press('KeyZ');
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(selectedId()).toBe(parser.id);
    expect(screen.getByText('Undid delete “fix parser”')).toBeInTheDocument();
    await advance(10_000);
    expect(api.count('decide')).toBe(0);
  });

  it('re-selects the row when its toast Undo button is clicked, like z', async () => {
    await renderInbox();
    press('KeyE', { shiftKey: true });
    expect(selectedId()).toBe(login.id);
    const toast = screen.getByText('Archive “fix parser”').parentElement as HTMLElement;
    click(within(toast).getByRole('button', { name: /Undo/ }));
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(selectedId()).toBe(parser.id);
    expect(screen.getByText('Undid archive “fix parser”')).toBeInTheDocument();
  });

  it('undoes from the toast while another tab is showing', async () => {
    await renderInbox();
    press('KeyE', { shiftKey: true });
    press('Digit2', { metaKey: true });
    const toast = screen.getByText('Archive “fix parser”').parentElement as HTMLElement;
    click(within(toast).getByRole('button', { name: /Undo/ }));
    expect(screen.getByText('Undid archive “fix parser”')).toBeInTheDocument();
    press('Digit1', { metaKey: true });
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it('sends delete only once its 10 s window has passed', async () => {
    await renderInbox();
    press('Digit3', { shiftKey: true });
    await advance(9_999);
    expect(api.count('decide')).toBe(0);
    await advance(1);
    expect(decideActions()).toEqual(['delete']);
  });

  it('sends keep_going with r and keep with s', async () => {
    await renderInbox();
    press('KeyR');
    press('KeyS');
    await advance(4_000);
    expect(api.argsOf('decide').map(([request]) => [request.action, request.id])).toEqual([
      ['keep_going', parser.id],
      ['keep', login.id],
    ]);
  });

  it('keeps the palette closed while a snooze dialog owns focus', async () => {
    await renderInbox();
    press('KeyH');
    const input = screen.getByRole('textbox', { name: 'Snooze until' });
    type(input, '3d');
    press('KeyK', { metaKey: true });
    expect(
      screen.getAllByRole('dialog').map((dialog) => dialog.getAttribute('aria-labelledby')),
    ).toEqual(['snooze-title']);
    expect(input).toHaveFocus();
    press('Escape');
    press('KeyK', { metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('snoozes through the dialog and keeps list keys away from its input', async () => {
    await renderInbox();
    press('KeyH');
    const dialog = screen.getByRole('dialog', { name: 'Snooze “fix parser” until…' });
    const input = within(dialog).getByRole('textbox', { name: 'Snooze until' });
    expect(input).toHaveFocus();
    press('KeyE');
    await advance(4_000);
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(api.count('decide')).toBe(0);
    type(input, 'tomorrow 9am');
    expect(within(dialog).getByText('Tomorrow, 09:00', { selector: 'p' })).toBeInTheDocument();
    act(() => {
      fireEvent.submit(input.closest('form') as HTMLFormElement);
    });
    expect(screen.queryByRole('dialog', { name: /Snooze/ })).toBeNull();
    expect(shownIds()).toEqual([login.id, docs.id]);
    await advance(4_000);
    expect(api.argsOf('decide').map(([request]) => request)).toEqual([
      {
        action: 'snooze',
        id: parser.id,
        mtime: parser.mtime,
        fingerprint: 'fp-p',
        until: new Date(2026, 9, 17, 9, 0).toISOString(),
      },
    ]);
  });

  it('resumes with o and reports a dry run', async () => {
    await renderInbox();
    press('KeyO');
    await flush();
    expect(api.argsOf('resume')).toEqual([[parser.id]]);
    const toast = screen.getByText('Dry run — would open “fix parser”');
    expect(toast.closest('[title]')).toHaveAttribute('title', `rl resume ${parser.id}`);
  });

  it('refuses archiving a running row and marks it running', async () => {
    const busy = makeRow({ id: 'claude-code:busy', label: 'busy one', running: true });
    await renderInbox(makeList([busy]));
    const option = within(listbox()).getByRole('option');
    expect(within(option).getByText('running')).toBeInTheDocument();
    press('KeyE', { shiftKey: true });
    expect(
      screen.getByText('busy one is still running — try again once it has stopped'),
    ).toBeInTheDocument();
    expect(shownIds()).toEqual([busy.id]);
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it('shows a lifecycle block on archive and still keeps going with r', async () => {
    const block = 'OpenCode sessions can only be kept going from circus';
    const open = makeRow({
      id: 'opencode:o',
      source: 'opencode',
      agent: 'opencode',
      session_id: 'o',
      label: 'opencode row',
      lifecycle_block: block,
    });
    await renderInbox(makeList([open]));
    press('KeyE', { shiftKey: true });
    expect(screen.getByText(block)).toBeInTheDocument();
    press('KeyR');
    await advance(4_000);
    expect(decideActions()).toEqual(['keep_going']);
  });

  it('archives from the reading-pane button exactly like ⇧E', async () => {
    await renderInbox();
    click(within(pane()).getByRole('button', { name: /^Archive/ }));
    expect(shownIds()).toEqual([login.id, docs.id]);
    expect(screen.getByText('Archive “fix parser”')).toBeInTheDocument();
    await advance(4_000);
    expect(decideActions()).toEqual(['archive']);
  });

  it('lists Delete with ⇧3 in the palette and runs Keep long-term from it', async () => {
    await renderInbox();
    press('KeyK', { metaKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    const deleteItem = within(palette).getByRole('option', { name: /^Delete/ });
    expect(within(deleteItem).getByText('⇧3')).toBeInTheDocument();
    click(within(palette).getByRole('option', { name: /^Keep long-term/ }));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    await advance(4_000);
    expect(api.argsOf('decide').map(([request]) => [request.action, request.id])).toEqual([
      ['keep', parser.id],
    ]);
  });

  it('returns focus to the list when the palette closes, and to search when Search runs', async () => {
    await renderInbox();
    act(() => listbox().focus());
    press('KeyK', { metaKey: true });
    expect(screen.getByRole('textbox', { name: 'Search commands' })).toHaveFocus();
    press('Escape');
    expect(listbox()).toHaveFocus();
    press('KeyK', { metaKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    click(within(palette).getByRole('option', { name: /^Search/ }));
    expect(search()).toHaveFocus();
  });

  it('keeps a pending archive across a tab switch and sends it on time', async () => {
    await renderInbox();
    press('KeyE', { shiftKey: true });
    await advance(1_000);
    press('Digit2', { metaKey: true });
    expect(screen.getByRole('tab', { name: 'Archive' })).toHaveAttribute('aria-selected', 'true');
    press('KeyJ');
    await advance(1_000);
    press('Digit1', { metaKey: true });
    expect(statusBar()).toHaveTextContent('1 waiting');
    expect(selectedId()).toBe(login.id);
    await advance(1_999);
    expect(api.count('decide')).toBe(0);
    await advance(1);
    expect(decideActions()).toEqual(['archive']);
  });
});

const keptOld = makeKeptRow({
  id: 'claude-code:k1',
  session_id: 'k1',
  label: 'kept long ago',
  mtime: '2026-07-01T12:00:00+00:00',
  kept_at: '2026-07-02T12:00:00+00:00',
  project: '/u/work/proj-02',
  project_short: '…/work/proj-02',
  project_key: '/u/work/proj-02',
  project_label: 'proj-02',
  file_fingerprint: 'fp-k1',
});
const keptNew = makeKeptRow({
  id: 'claude-code:k2',
  session_id: 'k2',
  label: 'kept lately',
  mtime: '2026-10-12T12:00:00+00:00',
  in_recent: true,
  kept_at: '2026-10-10T12:00:00+00:00',
  file_fingerprint: 'fp-k2',
});
const repos = () => screen.getByRole('navigation', { name: 'Repos' });
const transcript = () =>
  [...screen.getByRole('region', { name: 'Conversation' }).querySelectorAll('pre')]
    .map((pre) => pre.textContent)
    .join('');
const withKept = () => makeList(ROWS, { kept: [keptOld, keptNew] });
const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Splits' }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent);

async function openKept() {
  await renderInbox(withKept());
  click(screen.getByRole('tab', { name: /Kept/ }));
}

describe('InboxView Kept split', () => {
  it('offers Recent, Woke and All when the list has no kept rows', async () => {
    await renderInbox();
    expect(tabNames()).toEqual(['Recent 3', 'Woke 2', 'All 5']);
  });

  it('cycles into Kept with tab and lists the latest kept first', async () => {
    await renderInbox(withKept());
    expect(tabNames()).toEqual(['Recent 3', 'Woke 2', 'All 5', 'Kept 2']);
    press('Tab');
    press('Tab');
    press('Tab');
    expect(screen.getByRole('tab', { name: /Kept 2/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toEqual([keptNew.id, keptOld.id]);
    expect(field('Parked')).toBe('kept since Oct 10, 2026');
    press('Tab');
    expect(screen.getByRole('tab', { name: /Recent/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('says when nothing is kept', async () => {
    await renderInbox(makeList(ROWS, { kept: [] }));
    click(screen.getByRole('tab', { name: /Kept 0/ }));
    expect(screen.getByText('No kept sessions')).toBeInTheDocument();
  });

  it('returns a kept row to the inbox with u after the undo window', async () => {
    await openKept();
    press('KeyU');
    expect(shownIds()).toEqual([keptOld.id]);
    expect(screen.getByRole('tab', { name: /Kept 1/ })).toBeInTheDocument();
    expect(screen.getByText('Return “kept lately” to the inbox')).toBeInTheDocument();
    await advance(4_000);
    expect(api.decideRequest(0)).toEqual({
      action: 'unkeep',
      id: keptNew.id,
      mtime: keptNew.mtime,
      fingerprint: 'fp-k2',
      until: null,
    });
    await flush();
    expect(screen.getByText('Returned “kept lately” to the inbox')).toBeInTheDocument();
  });

  it('undoes an unkeep with z and selects the kept row again', async () => {
    await openKept();
    press('KeyU');
    press('KeyZ');
    expect(shownIds()).toEqual([keptNew.id, keptOld.id]);
    expect(selectedId()).toBe(keptNew.id);
    expect(screen.getByText('Undid return “kept lately” to the inbox')).toBeInTheDocument();
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it('keeps the selection when undoing an unkeep from another split', async () => {
    await openKept();
    press('KeyU');
    click(screen.getByRole('tab', { name: /Recent/ }));
    press('KeyJ');
    press('KeyZ');
    expect(screen.getByText('Undid return “kept lately” to the inbox')).toBeInTheDocument();
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(selectedId()).toBe(login.id);
  });

  it('returns every selected kept row under one toast', async () => {
    await openKept();
    press('Digit8', { shiftKey: true });
    press('KeyU');
    expect(screen.getByText('Return 2 sessions to the inbox')).toBeInTheDocument();
    await advance(4_000);
    await flush();
    await flush();
    expect(api.argsOf('decide').map(([request]) => [request.action, request.id])).toEqual([
      ['unkeep', keptNew.id],
      ['unkeep', keptOld.id],
    ]);
    expect(screen.getByText('Returned 2 sessions to the inbox')).toBeInTheDocument();
  });

  it('refuses to unkeep an inbox row and to snooze or keep a kept one', async () => {
    await renderInbox(withKept());
    press('KeyU');
    expect(screen.getByText('fix parser isn’t kept')).toBeInTheDocument();
    click(screen.getByRole('tab', { name: /Kept/ }));
    press('KeyH');
    expect(screen.queryByRole('dialog')).toBeNull();
    press('KeyS');
    expect(screen.getAllByText('kept lately is already kept')).toHaveLength(2);
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it('archives a kept row from the Kept split', async () => {
    await openKept();
    press('KeyE', { shiftKey: true });
    await advance(4_000);
    expect(api.argsOf('decide').map(([request]) => [request.action, request.id])).toEqual([
      ['archive', keptNew.id],
    ]);
  });

  it('offers Return to inbox instead of the parking actions in the reading pane', async () => {
    await openKept();
    const buttons = () =>
      within(pane())
        .getAllByRole('button')
        .map((button) => button.firstChild?.textContent);
    expect(buttons()).toEqual([
      'Return to inbox',
      'Harvest & archive',
      'Archive',
      'Delete',
      'Resume',
    ]);
    click(within(pane()).getByRole('button', { name: /Return to inbox/ }));
    expect(screen.getByText('Return “kept lately” to the inbox')).toBeInTheDocument();
  });

  it('falls back to Recent when a later list has no kept rows', async () => {
    await openKept();
    api.setList(makeList(ROWS));
    press('KeyE', { shiftKey: true });
    await advance(4_000);
    await flush();
    expect(tabNames()).toEqual(['Recent 3', 'Woke 2', 'All 5']);
    expect(screen.getByRole('tab', { name: /Recent/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('counts kept rows within the selected repo', async () => {
    await renderInbox(withKept());
    click(within(repos()).getByRole('button', { name: /proj-00/ }));
    expect(screen.getByRole('tab', { name: /Kept/ })).toHaveTextContent('Kept 1');
  });

  it('keeps a repo selected when switching to Kept only if it has kept rows', async () => {
    await renderInbox(withKept());
    click(within(repos()).getByRole('button', { name: /proj-00/ }));
    click(screen.getByRole('tab', { name: /Kept/ }));
    expect(within(repos()).getByRole('button', { name: /proj-00/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(shownIds()).toEqual([keptNew.id]);
    click(screen.getByRole('tab', { name: /All/ }));
    click(within(repos()).getByRole('button', { name: /proj-01/ }));
    click(screen.getByRole('tab', { name: /Kept/ }));
    expect(within(repos()).getByRole('button', { name: /All repos/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(shownIds()).toEqual([keptNew.id, keptOld.id]);
  });

  it('offers the next repo with kept rows and stays in Kept on Enter', async () => {
    await openKept();
    click(within(repos()).getByRole('button', { name: /proj-00/ }));
    press('KeyU');
    expect(
      screen.getByText('This repo is done. Next: proj-02 (1 kept) — Enter'),
    ).toBeInTheDocument();
    press('Enter');
    expect(screen.getByRole('tab', { name: /Kept/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toEqual([keptOld.id]);
  });

  it('shows a kept session’s conversation and keeps it across a rescan', async () => {
    await openKept();
    await advance(50);
    expect(transcript()).toBe(`tail of ${keptNew.id}`);
    const fetched = api.count('tails');
    api.setList(withKept());
    act(() => {
      harness.registry.dispatch(inboxListContext, 'rescan');
    });
    await advance(50);
    press('KeyJ');
    press('KeyK');
    await advance(50);
    expect(transcript()).toBe(`tail of ${keptNew.id}`);
    expect(api.count('tails')).toBe(fetched);
  });

  it('finds kept rows by search inside the Kept split', async () => {
    await openKept();
    press('Slash');
    type(search(), 'long ago');
    expect(shownIds()).toEqual([keptOld.id]);
  });
});

describe('InboxView search, splits and projects', () => {
  it('focuses search with /, narrows as you type and clears with Escape', async () => {
    await renderInbox();
    press('Slash');
    expect(search()).toHaveFocus();
    press('KeyJ');
    expect(selectedId()).toBe(parser.id);
    type(search(), 'parser');
    expect(shownIds()).toEqual([parser.id]);
    press('Escape');
    expect(search()).toHaveValue('');
    expect(listbox()).toHaveFocus();
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
  });

  it('switches to Woke with tab and orders it oldest first', async () => {
    await renderInbox();
    press('Tab');
    expect(screen.getByRole('tab', { name: /Woke 2/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id]);
    expect(selectedId()).toBe(wokeOlder.id);
    press('Tab', { shiftKey: true });
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
  });

  it('filters by a sidebar project and clears it with Escape', async () => {
    await renderInbox();
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    const project = within(projects).getByRole('button', { name: /proj-01/ });
    expect(project).toHaveTextContent('proj-012');
    click(project);
    expect(shownIds()).toEqual([parser.id, docs.id]);
    expect(project).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('tab', { name: /Recent 2/ })).toBeInTheDocument();
    press('Escape');
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
  });
});

describe('InboxView project filter and undo across splits', () => {
  it('drops a project filter that has no rows in the split it switches to', async () => {
    await renderInbox();
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    click(within(projects).getByRole('button', { name: /proj-01/ }));
    press('Tab');
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id]);
    expect(within(projects).getByRole('button', { name: /All repos/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('says a project filter hides everything when the project empties', async () => {
    await renderInbox();
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    click(within(projects).getByRole('button', { name: /proj-01/ }));
    press('KeyE', { shiftKey: true });
    press('KeyE', { shiftKey: true });
    expect(
      screen.getByText('This repo is done. Next: proj-00 (1 waiting) — Enter'),
    ).toBeInTheDocument();
    press('Enter');
    expect(within(projects).getByRole('button', { name: /proj-00/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id, login.id]);
    expect(api.count('resume')).toBe(0);
  });

  it('says the last project is done when no other project waits', async () => {
    await renderInbox(makeList([parser]));
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    click(within(projects).getByRole('button', { name: /proj-01/ }));
    press('KeyE', { shiftKey: true });
    expect(
      screen.getByText('This repo is done — all caught up. Esc shows all repos'),
    ).toBeInTheDocument();
  });

  it('keeps the selection when undoing a row that belongs to another split', async () => {
    await renderInbox();
    press('KeyE', { shiftKey: true });
    press('Tab');
    press('KeyJ');
    expect(selectedId()).toBe(wokeNewer.id);
    press('KeyZ');
    expect(selectedId()).toBe(wokeNewer.id);
  });
});

describe('InboxView banners and load states', () => {
  it('shows the unknown presence banner', async () => {
    await renderInbox(
      makeList(ROWS, { presence: { state: 'unknown', problem: 'ps exited with 1' } }),
    );
    const banner = screen.getByRole('note');
    expect(banner).toHaveTextContent(
      'Can’t tell which sessions are running, so archive, delete and harvest are off for now.',
    );
    expect(within(banner).getByText('ps exited with 1')).toBeInTheDocument();
  });

  it('turns on running-session detection from the banner and rescans', async () => {
    await renderInbox(
      makeList(ROWS, {
        presence: { state: 'unknown', problem: 'not installed', code: 'not_installed' },
      }),
    );
    const scans = api.count('scan');
    click(screen.getByRole('button', { name: 'Turn on running-session detection' }));
    await flush();
    expect(api.count('installPresence')).toBe(1);
    expect(api.count('scan')).toBe(scans + 1);
    expect(screen.getByText('Running-session detection is on')).toBeInTheDocument();
  });

  it('turns the detection button off while installing and reports a failure', async () => {
    await renderInbox(
      makeList(ROWS, {
        presence: { state: 'unknown', problem: 'not installed', code: 'not_installed' },
      }),
    );
    const install = api.defer('installPresence');
    click(screen.getByRole('button', { name: 'Turn on running-session detection' }));
    expect(screen.getByRole('button', { name: 'Turning on…' })).toBeDisabled();
    install.reject({
      kind: 'failed',
      message: 'Could not turn on running-session detection',
      exit_code: 1,
      stderr_tail: 'codex: config is read-only',
    });
    await flush();
    const toast = screen.getByText('Couldn’t turn on running-session detection');
    expect(toast.closest('[title]')).toHaveAttribute(
      'title',
      'Could not turn on running-session detection\ncodex: config is read-only',
    );
    expect(screen.getByRole('button', { name: 'Turn on running-session detection' })).toBeEnabled();
  });

  it('disables decisions in a sandbox whose registry is outside the world', async () => {
    await renderInbox(makeList(ROWS), (fake) => {
      fake.setDefault('appInfo', () =>
        Promise.resolve({ ...NATIVE_INFO, environment_label: 'sandbox', world_root: '/w' }),
      );
    });
    const blocked =
      'Sandbox registry /u/.local/share/ringleader/registry.json is outside /w — decisions are disabled';
    expect(screen.getByRole('note')).toHaveTextContent(blocked);
    expect(screen.getByText('SANDBOX')).toBeInTheDocument();
    press('KeyE', { shiftKey: true });
    expect(screen.getAllByText(blocked)).toHaveLength(2);
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it.each(['rl_not_found', 'rl_too_old'] as const)(
    'replaces the Inbox with setup when loading fails with %s',
    async (kind) => {
      await renderInbox(makeList(ROWS), (fake) => {
        fake.setDefault('cachedList', () => Promise.resolve(makeList([parser])));
        fake.setDefault('list', () => Promise.reject(circusError(kind, 'nope')));
        fake.setDefault('scan', () => Promise.reject(circusError(kind, 'nope')));
      });
      expect(screen.getByRole('heading', { name: 'Circus needs ringleader' })).toBeVisible();
      expect(screen.queryByRole('listbox', { name: 'Sessions' })).toBeNull();
    },
  );

  it('offers Retry for other load errors', async () => {
    await renderInbox(makeList(ROWS), (fake) => {
      fake.fail('list', circusError('failed', 'rl exited with code 2'));
      fake.fail('scan', circusError('failed', 'rl exited with code 2'));
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load sessions');
    expect(
      within(alert).getByText('rl exited with code 2', { selector: 'details p' }),
    ).toBeInTheDocument();
    const before = api.count('list');
    click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.count('list')).toBe(before + 1);
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('InboxView next steps and sidebar', () => {
  const snoozed = makeRow({
    id: 'claude-code:snoozed',
    label: 'wait for review',
    snoozed_at: '2026-10-10T12:00:00+00:00',
    snoozed_until: '2026-10-18T12:00:00+00:00',
  });
  const home = makeHome({
    counts: {
      triage_total: 5,
      live: 1,
      unclassified: 4,
      blocked: 0,
      stale: 0,
      kept: 2,
      projects: 2,
      spread_projects: 0,
    },
    projects: [
      {
        key: '/u/work/proj-01',
        label: 'proj-01',
        pending: 2,
        unclassified: 2,
        oldest_mtime: '2026-10-13T12:00:00+00:00',
        newest_mtime: '2026-10-15T12:00:00+00:00',
      },
    ],
    next_steps: [
      makeStep('roundup'),
      makeStep('woke', { count: 2 }),
      makeStep('recent', { count: 3 }),
      makeStep('publish', { count: 4 }),
      makeStep('project', { count: 2, project_key: '/u/work/proj-01' }),
    ],
    in_flight: [login.id],
    waking_soon: [snoozed.id],
    rows: [snoozed],
  });
  const withHome = () =>
    makeList(ROWS, {
      home,
      roundup: {
        last_at: '2026-10-13T12:00:00+00:00',
        age_human: '3d ago',
        stale: true,
        stale_hours: 8,
      },
    });
  const strip = () => screen.getByRole('region', { name: 'Next steps' });
  const stepItem = (text: string) =>
    within(strip())
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes(text)) as HTMLElement;

  it('lists every next step in order with the counts', async () => {
    await renderInbox(withHome());
    expect(
      within(strip())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Next:Sessions were last cleaned up 3d ago',
      '2 snoozed sessions woke upReview',
      '3 sessions from the last 7 daysTriage',
      '4 harvests to publishOpen Harvests',
      'proj-01: 2 waiting, oldest 3dTriage',
    ]);
    expect(within(strip()).getByText('5 waiting · 1 live · 4 unclassified · 2 kept')).toBeVisible();
  });

  it('opens the Woke split from its step', async () => {
    await renderInbox(withHome());
    click(within(stepItem('woke up')).getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('tab', { name: /Woke/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id]);
  });

  it('filters to the project from its step, across all splits', async () => {
    await renderInbox(withHome());
    click(within(stepItem('proj-01')).getByRole('button', { name: 'Triage' }));
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    expect(within(projects).getByRole('button', { name: /proj-01/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toEqual([docs.id, parser.id]);
  });

  it('switches the sidebar back to Repos for a project step', async () => {
    window.localStorage.setItem('circus.sidebar.view', 'folders');
    await renderInbox(withHome());
    expect(screen.getByRole('navigation', { name: 'Folders' })).toBeInTheDocument();
    click(within(stepItem('proj-01')).getByRole('button', { name: 'Triage' }));
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    expect(within(projects).getByRole('button', { name: /proj-01/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('switches to the Harvests tab from the publish step', async () => {
    await renderInbox(withHome());
    click(within(stepItem('harvests')).getByRole('button', { name: 'Open Harvests' }));
    expect(screen.getByRole('tab', { name: 'Harvests' })).toHaveAttribute('aria-selected', 'true');
  });

  it('resumes the session a resume step names', async () => {
    await renderInbox(
      makeList(ROWS, { home: makeHome({ next_steps: [makeStep('resume', { id: login.id })] }) }),
    );
    click(within(stepItem('fix flaky login')).getByRole('button', { name: 'Resume' }));
    await flush();
    expect(api.calls.filter((c) => c.method === 'resume').map((c) => c.args)).toEqual([[login.id]]);
  });

  it('counts a project step from the rows still shown, hiding pending decisions', async () => {
    await renderInbox(withHome());
    press('KeyE', { shiftKey: true });
    expect(stepItem('proj-01')).toHaveTextContent('proj-01: 1 waiting, oldest 3dTriage');
  });

  it('skips a project step whose project has nothing left to show', async () => {
    await renderInbox(
      makeList(ROWS, {
        home: makeHome({ next_steps: [makeStep('project', { count: 1, project_key: '/u/gone' })] }),
      }),
    );
    expect(within(strip()).getByText('All caught up')).toBeVisible();
  });

  it('skips a step of a kind it does not know and shows the rest', async () => {
    const unknown = { ...makeStep('woke', { count: 2 }), kind: 'mystery' } as unknown as NextStep;
    await renderInbox(
      makeList(ROWS, {
        home: makeHome({ next_steps: [unknown, makeStep('recent', { count: 3 })] }),
      }),
    );
    expect(
      within(strip())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Next:3 sessions from the last 7 daysTriage']);
  });

  it('says all caught up when there is no next step', async () => {
    await renderInbox(makeList(ROWS, { home: makeHome() }));
    expect(within(strip()).getByText('All caught up')).toBeVisible();
  });

  it('lists the sessions waking soon', async () => {
    await renderInbox(withHome());
    const waking = screen.getByRole('region', { name: 'Waking soon' });
    expect(within(waking).getByRole('listitem')).toHaveTextContent('wait for reviewin 2d');
  });

  it("shows each row's status", async () => {
    await renderInbox(makeList([makeRow({ id: 'claude-code:b', status: 'blocked' })]));
    expect(within(listbox()).getByRole('option')).toHaveTextContent('blocked');
  });
});

describe('InboxView triage with an agent', () => {
  const claude = { source: 'claude-code', agent: 'claude', installed: true };
  const codex = { source: 'codex', agent: 'codex', installed: true };
  const pi = { source: 'pi', agent: 'pi', installed: false };
  const withAgents = (agents: AgentInfo[]) => makeList(ROWS, { agents });

  it("hands the selected row's project to the only installed agent", async () => {
    await renderInbox(withAgents([claude, pi]));
    press('KeyT');
    await flush();
    await flush();
    const request = { project_key: '/u/work/proj-01', agent: 'claude-code' };
    expect(api.argsOf('previewHandoff')).toEqual([[request]]);
    expect(api.argsOf('launchHandoff')).toEqual([[request]]);
    expect(screen.getByText('Opened claude to triage proj-01 in iTerm2')).toBeInTheDocument();
  });

  it('asks which agent when several are installed, then hands off to the pick', async () => {
    await renderInbox(withAgents([claude, codex]));
    press('KeyT');
    const dialog = screen.getByRole('dialog', { name: 'Triage proj-01 with…' });
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['claude', 'codex']);
    click(within(dialog).getByRole('button', { name: 'codex' }));
    await flush();
    await flush();
    expect(api.argsOf('launchHandoff')).toEqual([
      [{ project_key: '/u/work/proj-01', agent: 'codex' }],
    ]);
  });

  it("triages the filtered project even when another project's row is selected", async () => {
    await renderInbox(withAgents([claude]));
    const projects = screen.getByRole('navigation', { name: 'Repos' });
    click(within(projects).getByRole('button', { name: /proj-00/ }));
    press('KeyT');
    await flush();
    expect(api.argsOf('previewHandoff')).toEqual([
      [{ project_key: '/u/work/proj-00', agent: 'claude-code' }],
    ]);
  });

  it('reports a refusal in its own words and launches nothing', async () => {
    await renderInbox(withAgents([claude]), (fake) =>
      fake.reply('previewHandoff', {
        version: 1,
        kind: 'handoff',
        purpose: 'triage',
        status: 'refused',
        code: 'nothing_to_triage',
        reason: 'no project /u/work/proj-01 is waiting for triage',
        source: 'claude-code',
        agent: 'claude',
        project_key: '/u/work/proj-01',
        cwd: null,
        argv: null,
      }),
    );
    press('KeyT');
    await flush();
    await flush();
    expect(screen.getByText('Nothing in proj-01 is waiting for triage')).toBeInTheDocument();
    expect(api.count('launchHandoff')).toBe(0);
  });

  it('reports a failed preview and launches nothing', async () => {
    await renderInbox(withAgents([claude]), (fake) =>
      fake.fail('previewHandoff', circusError('timeout', 'took too long')),
    );
    press('KeyT');
    await flush();
    const toast = screen.getByText('Couldn’t start triage of proj-01');
    expect(toast.closest('[title]')).toHaveAttribute('title', 'took too long');
    expect(api.count('launchHandoff')).toBe(0);
  });

  it('reports a failed launch', async () => {
    await renderInbox(withAgents([claude]), (fake) =>
      fake.fail('launchHandoff', circusError('launch', 'iTerm2 did not answer')),
    );
    press('KeyT');
    await flush();
    await flush();
    const toast = screen.getByText('Couldn’t start triage of proj-01');
    expect(toast.closest('[title]')).toHaveAttribute('title', 'iTerm2 did not answer');
  });

  it('focuses the agent picked last time', async () => {
    window.localStorage.setItem('circus.triage-agent', 'codex');
    await renderInbox(withAgents([claude, codex]));
    press('KeyT');
    const dialog = screen.getByRole('dialog', { name: 'Triage proj-01 with…' });
    expect(within(dialog).getByRole('button', { name: 'codex' })).toHaveFocus();
  });

  it('remembers the picked agent for next time', async () => {
    await renderInbox(withAgents([claude, codex]));
    press('KeyT');
    click(within(screen.getByRole('dialog')).getByRole('button', { name: 'codex' }));
    await flush();
    expect(window.localStorage.getItem('circus.triage-agent')).toBe('codex');
  });

  it('keeps the palette closed while the agent picker is open', async () => {
    await renderInbox(withAgents([claude, codex]));
    press('KeyT');
    press('KeyK', { metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it("triages the marked row's project rather than the selected row's", async () => {
    await renderInbox(withAgents([claude]));
    press('KeyJ');
    press('KeyX');
    press('KeyK');
    press('KeyT');
    await flush();
    expect(api.argsOf('previewHandoff')).toEqual([
      [{ project_key: '/u/work/proj-00', agent: 'claude-code' }],
    ]);
  });

  it('refuses to triage marked rows from several projects', async () => {
    await renderInbox(withAgents([claude]));
    press('KeyX');
    press('KeyJ');
    press('KeyX');
    press('KeyT');
    expect(
      screen.getByText(
        'The selected sessions are in several projects — triage one project at a time',
      ),
    ).toBeInTheDocument();
    expect(api.count('previewHandoff')).toBe(0);
  });

  it('says when no agent is installed', async () => {
    await renderInbox(withAgents([pi]));
    press('KeyT');
    expect(screen.getByText('No agent is installed to triage with')).toBeInTheDocument();
    expect(api.count('previewHandoff')).toBe(0);
  });
});

describe('InboxView selection and bulk decisions', () => {
  const extra = makeRow({
    id: 'claude-code:x',
    session_id: 'x',
    label: 'extra',
    mtime: '2026-10-12T12:00:00+00:00',
    file_fingerprint: 'fp-x',
  });
  const highlighted = () =>
    within(listbox())
      .queryAllByRole('option', { selected: true })
      .map((option) => option.dataset.rowId);
  const marked = () =>
    screen.queryByText(/^\d+ selected$/) === null
      ? []
      : within(listbox())
          .queryAllByRole('option', { selected: true })
          .map((option) => option.dataset.rowId);
  const row = (id: string) =>
    within(listbox())
      .getAllByRole('option')
      .find((option) => option.dataset.rowId === id) as HTMLElement;
  const decidedIds = () => api.argsOf('decide').map(([request]) => request.id);
  const markParserAndLogin = () => {
    press('KeyX');
    press('KeyJ');
    press('KeyX');
  };

  it('toggles a mark on the selected row with x and counts the marks', async () => {
    await renderInbox();
    markParserAndLogin();
    expect(marked()).toEqual([parser.id, login.id]);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    press('KeyX');
    expect(marked()).toEqual([parser.id]);
  });

  it('marks every shown row with * and clears them with a second *', async () => {
    await renderInbox();
    press('Digit8', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
    press('Digit8', { shiftKey: true });
    expect(marked()).toEqual([]);
  });

  it('applies keep to every marked row under one toast and one summary', async () => {
    await renderInbox();
    markParserAndLogin();
    press('KeyS');
    expect(screen.getByText('Keep 2 sessions')).toBeInTheDocument();
    expect(shownIds()).toEqual([docs.id]);
    expect(marked()).toEqual([]);
    await advance(4_000);
    await flush();
    expect(decidedIds()).toEqual([parser.id, login.id]);
    expect(decideActions()).toEqual(['keep', 'keep']);
    expect(screen.getByText('Kept 2 sessions')).toBeInTheDocument();
  });

  it('undoes a whole bulk decision with one z', async () => {
    await renderInbox();
    markParserAndLogin();
    press('KeyS');
    press('KeyZ');
    expect(screen.getByText('Undid keep of 2 sessions')).toBeInTheDocument();
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it('confirms a bulk archive and sends nothing when cancelled', async () => {
    await renderInbox();
    markParserAndLogin();
    press('KeyE', { shiftKey: true });
    const dialog = screen.getByRole('alertdialog', { name: 'Archive 2 sessions?' });
    click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(marked()).toEqual([parser.id, login.id]);
    await advance(4_000);
    expect(api.count('decide')).toBe(0);
  });

  it('sends a confirmed bulk delete for every marked row', async () => {
    await renderInbox();
    markParserAndLogin();
    press('Digit3', { shiftKey: true });
    const dialog = screen.getByRole('alertdialog', {
      name: 'Delete 2 sessions permanently?',
    });
    expect(dialog).toHaveTextContent('Nothing is harvested.');
    click(within(dialog).getByRole('button', { name: 'Delete 2' }));
    expect(screen.getByText('Deleting 2 sessions in 10 s')).toBeInTheDocument();
    await advance(10_000);
    await flush();
    expect(decideActions()).toEqual(['delete', 'delete']);
    expect(decidedIds()).toEqual([parser.id, login.id]);
  });

  it('refuses to harvest several sessions at once', async () => {
    await renderInbox();
    markParserAndLogin();
    press('KeyE');
    expect(
      screen.getByText('Harvest one session at a time — deselect all but one'),
    ).toBeInTheDocument();
    expect(marked()).toEqual([parser.id, login.id]);
  });

  it('decides on the single marked row rather than the selected one', async () => {
    await renderInbox();
    press('KeyX');
    press('KeyJ');
    press('KeyS');
    expect(screen.getByText('Keep “fix parser”')).toBeInTheDocument();
    expect(shownIds()).toEqual([login.id, docs.id]);
  });

  it('resumes the single marked row rather than the selected one', async () => {
    await renderInbox();
    press('KeyJ');
    press('KeyX');
    press('KeyK');
    press('KeyO');
    await flush();
    expect(api.argsOf('resume')).toEqual([[login.id]]);
  });

  it('resumes one session at a time', async () => {
    await renderInbox();
    markParserAndLogin();
    press('KeyO');
    await flush();
    expect(
      screen.getByText('Resume one session at a time — deselect all but one'),
    ).toBeInTheDocument();
    expect(api.count('resume')).toBe(0);
  });

  it('styles a bulk delete as destructive and a bulk archive as normal', async () => {
    await renderInbox();
    markParserAndLogin();
    press('Digit3', { shiftKey: true });
    expect(screen.getByRole('button', { name: 'Delete 2' }).className).toContain('bg-red-600');
    click(screen.getByRole('button', { name: 'Cancel' }));
    press('KeyE', { shiftKey: true });
    expect(screen.getByRole('button', { name: 'Archive 2' }).className).toContain('bg-blue-600');
  });

  it('keeps Tab inside the confirmation and the palette closed over it', async () => {
    await renderInbox();
    markParserAndLogin();
    press('KeyE', { shiftKey: true });
    const dialog = screen.getByRole('alertdialog', { name: 'Archive 2 sessions?' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Archive 2' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    press('KeyK', { metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('selects one row on click and adds or removes rows on ⌘-click', async () => {
    await renderInbox();
    click(row(login.id));
    expect(selectedId()).toBe(login.id);
    expect(marked()).toEqual([]);
    click(row(docs.id), { metaKey: true });
    expect(marked()).toEqual([login.id, docs.id]);
    expect(selectedId()).toBe(docs.id);
    click(row(login.id), { metaKey: true });
    expect(marked()).toEqual([docs.id]);
    click(row(parser.id));
    expect(marked()).toEqual([]);
    expect(selectedId()).toBe(parser.id);
  });

  it('leaves nothing to decide on after ⌘-click deselects the last selected row', async () => {
    await renderInbox();
    click(row(login.id));
    click(row(docs.id), { metaKey: true });
    click(row(docs.id), { metaKey: true });
    click(row(login.id), { metaKey: true });
    expect(highlighted()).toEqual([]);
    expect(selectedId()).toBe(login.id);
    press('KeyS');
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    press('KeyJ');
    expect(highlighted()).toEqual([docs.id]);
  });

  it('asks to confirm a delete of a selected row that is not the open one', async () => {
    await renderInbox();
    press('KeyX');
    press('KeyJ');
    press('Digit3', { shiftKey: true });
    expect(
      screen.getByRole('alertdialog', { name: 'Delete 1 session permanently?' }),
    ).toBeInTheDocument();
  });

  it('decides on the whole range a ⇧-click selects', async () => {
    await renderInbox();
    click(row(docs.id));
    click(row(parser.id), { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
    press('KeyS');
    await advance(4_000);
    await flush();
    expect(decidedIds()).toEqual([parser.id, login.id, docs.id]);
  });

  it('adds a ⇧-click range to rows picked with ⌘-click', async () => {
    await renderInbox(makeList([...ROWS, extra]));
    click(row(parser.id));
    click(row(docs.id), { metaKey: true });
    click(row('claude-code:x'), { shiftKey: true });
    expect(marked()).toEqual([parser.id, docs.id, 'claude-code:x']);
  });

  it('selects every shown row with ⌘A', async () => {
    await renderInbox();
    type(search(), 'fix');
    act(() => listbox().focus());
    press('KeyA', { metaKey: true });
    expect(marked()).toEqual([parser.id, login.id]);
  });

  it('clears the selection with Esc before the search', async () => {
    await renderInbox();
    type(search(), 'fix');
    act(() => listbox().focus());
    press('KeyJ', { shiftKey: true });
    press('Escape');
    expect(marked()).toEqual([]);
    expect(search()).toHaveValue('fix');
  });

  it('clears the selection with Esc before the sidebar selection', async () => {
    await renderInbox();
    const project = within(screen.getByRole('navigation', { name: 'Repos' })).getByRole('button', {
      name: /proj-01/,
    });
    click(project);
    press('KeyJ', { shiftKey: true });
    press('Escape');
    expect(marked()).toEqual([]);
    expect(project).toHaveAttribute('aria-current', 'true');
    press('Escape');
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
  });

  it('returns focus to the list after a dialog opened from the palette closes', async () => {
    await renderInbox();
    act(() => listbox().focus());
    press('KeyK', { metaKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    click(within(palette).getByRole('option', { name: /^Snooze/ }));
    press('Escape');
    expect(listbox()).toHaveFocus();
  });

  it('selects every shown row when Select all runs from the palette', async () => {
    await renderInbox();
    act(() => listbox().focus());
    press('KeyK', { metaKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    click(within(palette).getByRole('option', { name: /^Select all/ }));
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
  });

  it('selects the palette text on ⌘A inside the palette', async () => {
    await renderInbox();
    act(() => listbox().focus());
    press('KeyK', { metaKey: true });
    const input = screen.getByRole('textbox', { name: 'Search commands' }) as HTMLInputElement;
    type(input, 'sel');
    press('KeyA', { metaKey: true });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    expect(marked()).toEqual([]);
  });

  it('drops selected rows a search hides', async () => {
    await renderInbox();
    press('KeyJ', { shiftKey: true });
    press('KeyJ', { shiftKey: true });
    type(search(), 'fix');
    expect(marked()).toEqual([parser.id, login.id]);
    type(search(), '');
    expect(marked()).toEqual([parser.id, login.id]);
  });

  it('joins the highlighted row on ⌘-click after a search hid the selection', async () => {
    await renderInbox();
    press('End');
    press('KeyX');
    type(search(), 'fix');
    act(() => listbox().focus());
    click(row(parser.id), { metaKey: true });
    expect(marked()).toEqual([parser.id, login.id]);
  });

  it('moves to the row after a removed range when the cursor ends the range', async () => {
    await renderInbox(makeList([...ROWS, extra]));
    press('KeyJ', { shiftKey: true });
    press('KeyS');
    expect(shownIds()).toEqual([docs.id, 'claude-code:x']);
    expect(selectedId()).toBe(docs.id);
  });

  it('selects the search text on ⌘A in the search box', async () => {
    await renderInbox();
    type(search(), 'fix');
    act(() => search().focus());
    press('KeyA', { metaKey: true });
    expect(marked()).toEqual([]);
    expect([
      (search() as HTMLInputElement).selectionStart,
      (search() as HTMLInputElement).selectionEnd,
    ]).toEqual([0, 3]);
  });

  it('leaves Home to the search box', async () => {
    await renderInbox();
    press('KeyJ');
    act(() => search().focus());
    press('Home');
    expect(selectedId()).toBe(login.id);
  });

  it('extends the selection with ⇧J and ⇧K', async () => {
    await renderInbox();
    press('KeyJ', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id]);
    press('KeyJ', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
    press('KeyK', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id]);
    expect(selectedId()).toBe(login.id);
  });

  it('extends the selection with ⇧↓ and ⇧↑', async () => {
    await renderInbox();
    press('ArrowDown', { shiftKey: true });
    press('ArrowDown', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
    press('ArrowUp', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id]);
  });

  it('keeps a single selection when ⇧K finds no row above', async () => {
    await renderInbox();
    press('KeyK', { shiftKey: true });
    expect(marked()).toEqual([]);
    expect(highlighted()).toEqual([parser.id]);
  });

  it('starts a new range after a plain move back to where the last one ended', async () => {
    await renderInbox();
    press('KeyJ', { shiftKey: true });
    press('KeyJ', { shiftKey: true });
    press('KeyK');
    press('KeyJ');
    press('KeyK', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
  });

  it('jumps to the last and first row', async () => {
    await renderInbox();
    press('End');
    expect(selectedId()).toBe(docs.id);
    press('Home');
    expect(selectedId()).toBe(parser.id);
    expect(marked()).toEqual([]);
  });

  it('extends the selection to the last and first row', async () => {
    await renderInbox();
    press('End', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
    expect(selectedId()).toBe(docs.id);
    press('Escape');
    press('Home', { shiftKey: true });
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
    expect(selectedId()).toBe(parser.id);
  });

  it('opens a row on double-click', async () => {
    await renderInbox();
    act(() => {
      fireEvent.doubleClick(row(login.id));
    });
    await flush();
    expect(api.argsOf('resume')).toEqual([[login.id]]);
  });

  it('clears the selection when the sidebar selection changes', async () => {
    await renderInbox();
    press('KeyA', { metaKey: true });
    expect(marked()).toHaveLength(3);
    click(
      within(screen.getByRole('navigation', { name: 'Repos' })).getByRole('button', {
        name: /proj-01/,
      }),
    );
    expect(marked()).toEqual([]);
  });

  it('clears the selection when the split changes', async () => {
    await renderInbox();
    press('KeyX');
    expect(marked()).toHaveLength(1);
    press('Tab', { shiftKey: true });
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    expect(shownIds()).toContain(parser.id);
    expect(marked()).toEqual([]);
  });

  it('selects every shown row when Select all runs from the palette with nothing focused', async () => {
    await renderInbox();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    press('KeyK', { metaKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    click(within(palette).getByRole('option', { name: /^Select all/ }));
    expect(marked()).toEqual([parser.id, login.id, docs.id]);
  });

  it('asks to confirm harvesting a selected row that is not the open one', async () => {
    await renderInbox();
    press('KeyX');
    press('KeyJ');
    press('KeyE');
    expect(
      screen.getByRole('alertdialog', { name: 'Harvest and archive 1 session?' }),
    ).toBeInTheDocument();
  });

  it('selects a row again on ⇧-click after ⌘-click deselected it', async () => {
    await renderInbox();
    click(row(login.id));
    click(row(login.id), { metaKey: true });
    expect(highlighted()).toEqual([]);
    click(row(login.id), { shiftKey: true });
    expect(highlighted()).toEqual([login.id]);
  });

  it('refuses a bulk archive of running rows without asking to confirm', async () => {
    const busyA = makeRow({ id: 'claude-code:ba', label: 'busy a', running: true });
    const busyB = makeRow({ id: 'claude-code:bb', label: 'busy b', running: true });
    await renderInbox(makeList([busyA, busyB]));
    press('Digit8', { shiftKey: true });
    press('KeyE', { shiftKey: true });
    expect(screen.getByText('Skipped 2 sessions')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('InboxView sidebar layout', () => {
  const separator = () => screen.getByRole('separator', { name: 'Resize sidebar' });
  const columns = () => separator().parentElement?.parentElement?.style.gridTemplateColumns;
  const resizeWindow = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };
  const capture = vi.fn();
  const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: capture,
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
    if (innerWidth !== undefined) Object.defineProperty(window, 'innerWidth', innerWidth);
  });

  it('starts at the default width and resizes with the arrow keys, remembering the width', async () => {
    await renderInbox();
    expect(separator()).toHaveAttribute('aria-valuenow', '288');
    act(() => {
      separator().focus();
    });
    act(() => {
      fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    });
    expect(separator()).toHaveAttribute('aria-valuenow', '304');
    expect(columns()).toMatch(/^min\(304px, 40vw\) /);
    cleanup();
    await renderInbox();
    expect(separator()).toHaveAttribute('aria-valuenow', '304');
  });

  it('reports and steps from the width the window allows', async () => {
    window.localStorage.setItem('circus.sidebar.width', '512');
    await renderInbox();
    resizeWindow(900);
    expect(separator()).toHaveAttribute('aria-valuenow', '360');
    act(() => {
      fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    });
    expect(separator()).toHaveAttribute('aria-valuenow', '344');
    expect(window.localStorage.getItem('circus.sidebar.width')).toBe('344');
  });

  it('follows a drag, keeps it within bounds and resets on double-click', async () => {
    await renderInbox();
    act(() => {
      fireEvent.pointerDown(separator(), { pointerId: 1, button: 0, clientX: 288 });
      fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 340 });
    });
    expect(document.body).toHaveClass('circus-resizing');
    expect(columns()).toMatch(/^min\(340px, 40vw\) /);
    expect(separator()).toHaveAttribute('aria-valuenow', '288');
    act(() => {
      fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 2000 });
      fireEvent.pointerUp(separator(), { pointerId: 1, clientX: 2000 });
    });
    expect(document.body).not.toHaveClass('circus-resizing');
    expect(window.localStorage.getItem('circus.sidebar.width')).toBe('512');
    expect(separator()).toHaveAttribute('aria-valuenow', '409');
    act(() => {
      fireEvent.doubleClick(separator());
    });
    expect(separator()).toHaveAttribute('aria-valuenow', '288');
    expect(capture).toHaveBeenCalledWith(1);
  });

  it('keeps the saved width on a click without a drag, and commits a cancelled drag', async () => {
    window.localStorage.setItem('circus.sidebar.width', '512');
    await renderInbox();
    resizeWindow(900);
    act(() => {
      fireEvent.pointerDown(separator(), { pointerId: 2, button: 0, clientX: 360 });
      fireEvent.pointerUp(separator(), { pointerId: 2, clientX: 360 });
    });
    expect(window.localStorage.getItem('circus.sidebar.width')).toBe('512');
    act(() => {
      fireEvent.pointerDown(separator(), { pointerId: 3, button: 0, clientX: 360 });
      fireEvent.pointerMove(separator(), { pointerId: 3, clientX: 300 });
      fireEvent.pointerCancel(separator(), { pointerId: 3 });
    });
    expect(window.localStorage.getItem('circus.sidebar.width')).toBe('300');
    expect(document.body).not.toHaveClass('circus-resizing');
  });
});

describe('InboxView sidebar views', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const nav = (name: string) => screen.getByRole('navigation', { name });

  it('groups by folder, keeps each view its own selection and remembers the view', async () => {
    await renderInbox();
    click(tab('Folders'));
    const folder = within(nav('Folders')).getByRole('button', { name: /proj-01/ });
    expect(folder).toHaveTextContent('~/work/proj-012');
    click(folder);
    expect(shownIds()).toEqual([parser.id, docs.id]);
    click(tab('Repos'));
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    click(tab('Folders'));
    expect(shownIds()).toEqual([parser.id, docs.id]);
    expect(window.localStorage.getItem('circus.sidebar.view')).toBe('folders');
    cleanup();
    await renderInbox();
    expect(tab('Folders')).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a folder tree where a parent folder holds every session under it', async () => {
    await renderInbox();
    click(tab('Tree'));
    const tree = nav('Folder tree');
    click(within(tree).getByRole('button', { name: /^~\/work3/ }));
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    click(within(tree).getByRole('button', { name: /^proj-01/ }));
    expect(shownIds()).toEqual([parser.id, docs.id]);
    click(within(tree).getByRole('button', { name: 'Collapse ~/work' }));
    expect(within(tree).getByRole('button', { name: 'Expand ~/work' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(shownIds()).toEqual([parser.id, docs.id]);
  });

  it('groups by day of last activity', async () => {
    await renderInbox();
    click(tab('Dates'));
    const dates = within(nav('Dates'))
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(dates).toEqual(['All dates3', '2026-10-151', '2026-10-141', '2026-10-131']);
    click(within(nav('Dates')).getByRole('button', { name: /^2026-10-14/ }));
    expect(shownIds()).toEqual([login.id]);
  });

  it('drops a selection in another view that has no rows in the split it switches to', async () => {
    await renderInbox();
    click(tab('Folders'));
    click(within(nav('Folders')).getByRole('button', { name: /proj-01/ }));
    click(tab('Repos'));
    press('Tab');
    click(tab('Folders'));
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id]);
    expect(within(nav('Folders')).getByRole('button', { name: /All folders/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('drops a day selection from before a day change that has no rows in the next split', async () => {
    const today = makeRow({
      id: 'claude-code:t',
      session_id: 't',
      mtime: '2026-10-16T12:00:00+00:00',
    });
    const wokeTomorrow = makeRow({
      id: 'claude-code:w3',
      session_id: 'w3',
      mtime: '2026-10-17T12:00:00+00:00',
      in_recent: false,
      woke: true,
    });
    await renderInbox(makeList([today, ...ROWS]));
    click(tab('Dates'));
    click(within(nav('Dates')).getByRole('button', { name: /^2026-10-16/ }));
    api.setList(
      makeList([today, wokeTomorrow, ...ROWS], { generated_at: '2026-10-17T12:00:00+00:00' }),
    );
    act(() => {
      harness.registry.dispatch(inboxListContext, 'rescan');
    });
    await flush();
    expect(shownIds()).toEqual([today.id]);
    press('Tab');
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id, wokeTomorrow.id]);
    expect(within(nav('Dates')).getByRole('button', { name: /All dates/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('names the next folder by its whole path when a folder empties', async () => {
    await renderInbox();
    click(tab('Folders'));
    click(within(nav('Folders')).getByRole('button', { name: /proj-01/ }));
    press('KeyE', { shiftKey: true });
    press('KeyE', { shiftKey: true });
    expect(
      screen.getByText('This folder is done. Next: ~/work/proj-00 (1 waiting) — Enter'),
    ).toBeInTheDocument();
  });

  it('triages the one project a folder holds', async () => {
    await renderInbox(
      makeList(ROWS, { agents: [{ source: 'claude-code', agent: 'claude', installed: true }] }),
    );
    click(tab('Folders'));
    click(within(nav('Folders')).getByRole('button', { name: /proj-01/ }));
    press('KeyJ');
    press('KeyJ');
    press('KeyT');
    await flush();
    expect(api.argsOf('previewHandoff')).toEqual([
      [{ project_key: '/u/work/proj-01', agent: 'claude-code' }],
    ]);
  });

  it('switches the view from the palette', async () => {
    await renderInbox();
    act(() => {
      harness.registry.dispatch(inboxListContext, 'sidebarDates');
    });
    expect(screen.getByRole('tab', { name: 'Dates' })).toHaveAttribute('aria-selected', 'true');
    act(() => {
      harness.registry.dispatch(inboxListContext, 'sidebarTree');
    });
    expect(screen.getByRole('navigation', { name: 'Folder tree' })).toBeInTheDocument();
  });
});
