import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { CircusError, ListResponse } from '../api/types';
import { ShortcutRegistryProvider } from '../shortcuts/react';
import {
  createFakeApi,
  NATIVE_INFO,
  okOutcome,
  type Deferred,
  type FakeApi,
} from '../test/fakeApi';
import { makeList, makeRow } from '../test/fixtures';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { scrollToShow } from './rowWindow';

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
    <ShortcutRegistryProvider registry={harness.registry}>
      <App api={api} />
    </ShortcutRegistryProvider>,
  );
  await flush();
  await flush();
}

const type = (input: HTMLElement, value: string) => {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
};
const click = (element: HTMLElement) => {
  act(() => {
    fireEvent.click(element);
  });
};
const search = () => screen.getByRole('searchbox', { name: 'Search sessions' });
const listbox = () => screen.getByRole('listbox', { name: 'Sessions' });
const shownIds = () =>
  within(listbox())
    .queryAllByRole('option')
    .map((option) => option.dataset.rowId);
const selectedId = () =>
  within(listbox()).getByRole('option', { selected: true }).dataset.rowId ?? null;
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
  harness.dispose();
  vi.useRealTimers();
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
    await renderInbox();
    const shortcuts = vi.spyOn(harness.registry, 'shortcuts');
    press('KeyJ');
    expect(shortcuts).not.toHaveBeenCalled();
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
    press('Digit3', { metaKey: true });
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
    expect(screen.getByText(`Dry run: rl resume ${parser.id}`)).toBeInTheDocument();
  });

  it('refuses archiving a running row and marks it running', async () => {
    const busy = makeRow({ id: 'claude-code:busy', label: 'busy one', running: true });
    await renderInbox(makeList([busy]));
    const option = within(listbox()).getByRole('option');
    expect(within(option).getByText('running')).toBeInTheDocument();
    press('KeyE', { shiftKey: true });
    expect(
      screen.getByText(
        'busy one is running — finish it from inside with the ringleader-finish skill',
      ),
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
    expect(screen.getByRole('tab', { name: 'Triage' })).toHaveAttribute('aria-selected', 'true');
    press('KeyJ');
    await advance(1_000);
    press('Digit3', { metaKey: true });
    expect(statusBar()).toHaveTextContent('1 waiting');
    expect(selectedId()).toBe(login.id);
    await advance(1_999);
    expect(api.count('decide')).toBe(0);
    await advance(1);
    expect(decideActions()).toEqual(['archive']);
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
    const projects = screen.getByRole('navigation', { name: 'Projects' });
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
    const projects = screen.getByRole('navigation', { name: 'Projects' });
    click(within(projects).getByRole('button', { name: /proj-01/ }));
    press('Tab');
    expect(shownIds()).toEqual([wokeOlder.id, wokeNewer.id]);
    expect(within(projects).getByRole('button', { name: /All projects/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('says a project filter hides everything when the project empties', async () => {
    await renderInbox();
    const projects = screen.getByRole('navigation', { name: 'Projects' });
    click(within(projects).getByRole('button', { name: /proj-01/ }));
    press('KeyE', { shiftKey: true });
    press('KeyE', { shiftKey: true });
    expect(
      screen.getByText('No sessions in this project — Esc shows all projects'),
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
  it('shows the stale roundup and unknown presence banners', async () => {
    await renderInbox(
      makeList(ROWS, {
        roundup: {
          last_at: '2026-10-13T12:00:00+00:00',
          age_human: '3d ago',
          stale: true,
          stale_hours: 8,
        },
        presence: { state: 'unknown', problem: 'ps exited with 1' },
      }),
    );
    expect(
      screen.getByText(
        'Roundup last ran 3d ago — run it with `rl roundup`; the Enrich tab will run it later',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Can't tell which sessions are running — archive, delete and harvest will be refused. ps exited with 1",
      ),
    ).toBeInTheDocument();
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

  it('replaces the Inbox with the rl_not_found message', async () => {
    const message = 'Could not find rl. Set CIRCUS_RL or rl_command in /u/settings.json';
    await renderInbox(makeList(ROWS), (fake) => {
      fake.setDefault('list', () => Promise.reject(circusError('rl_not_found', message)));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('listbox', { name: 'Sessions' })).toBeNull();
  });

  it('shows the rl_too_old message', async () => {
    const message = 'rl is too old for circus — run `just install` in ringleader';
    await renderInbox(makeList(ROWS), (fake) => {
      fake.setDefault('list', () => Promise.reject(circusError('rl_too_old', message)));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('keeps a cached list and shows the rl_not_found message as a banner', async () => {
    const message = 'Could not find rl. Set CIRCUS_RL or rl_command in /u/settings.json';
    await renderInbox(makeList(ROWS), (fake) => {
      fake.setDefault('cachedList', () => Promise.resolve(makeList([parser])));
      fake.setDefault('list', () => Promise.reject(circusError('rl_not_found', message)));
    });
    expect(shownIds()).toEqual([parser.id]);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('offers Retry for other load errors', async () => {
    await renderInbox(makeList(ROWS), (fake) => {
      fake.fail('list', circusError('failed', 'rl gui list exited with 2'));
      fake.fail('list', circusError('failed', 'rl gui list exited with 2'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('rl gui list exited with 2');
    const before = api.count('list');
    click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.count('list')).toBe(before + 1);
    expect(shownIds()).toEqual([parser.id, login.id, docs.id]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
