import {
  createRegistry,
  defineContext,
  memoryStore,
  type RegistrySnapshot,
  type ShortcutContext,
  type ShortcutRegistry,
} from '@shortcutkit/core';

export const appContext = defineContext({
  id: 'app',
  displayName: 'App',
  actions: {
    goInbox: { displayName: 'Go to Inbox', defaults: 'mod+1' },
    goArchive: { displayName: 'Go to Archive', defaults: 'mod+2' },
    goHarvests: { displayName: 'Go to Harvests', defaults: 'mod+3' },
    openPalette: { displayName: 'Command palette', defaults: 'mod+k' },
  },
});

export const inboxListContext = defineContext({
  id: 'inbox.list',
  displayName: 'Inbox',
  actions: {
    next: { displayName: 'Next session', defaults: ['j', 'down'] },
    previous: { displayName: 'Previous session', defaults: ['k', 'up'] },
    harvestArchive: { displayName: 'Harvest, then archive', defaults: 'e', allowsKeyRepeat: false },
    archive: {
      displayName: 'Archive without harvesting',
      defaults: 'shift+e',
      allowsKeyRepeat: false,
    },
    delete: { displayName: 'Delete', defaults: 'shift+3', allowsKeyRepeat: false },
    snooze: { displayName: 'Snooze…', defaults: 'h', allowsKeyRepeat: false },
    keep: { displayName: 'Keep long-term', defaults: 's', allowsKeyRepeat: false },
    keepGoing: { displayName: 'Keep going (mark reviewed)', defaults: 'r', allowsKeyRepeat: false },
    resume: { displayName: 'Resume in terminal', defaults: ['o', 'enter'], allowsKeyRepeat: false },
    triageWithAgent: {
      displayName: 'Triage the project with an agent',
      defaults: 't',
      allowsKeyRepeat: false,
    },
    undo: { displayName: 'Undo', defaults: 'z', allowsKeyRepeat: false },
    mark: { displayName: 'Mark or unmark', defaults: 'x' },
    markAll: { displayName: 'Mark or unmark all', defaults: 'shift+8', allowsKeyRepeat: false },
    search: { displayName: 'Search', defaults: 'slash' },
    back: { displayName: 'Back', defaults: 'escape' },
    nextSplit: { displayName: 'Next split', defaults: 'tab' },
    previousSplit: { displayName: 'Previous split', defaults: 'shift+tab' },
    rescan: { displayName: 'Rescan sessions' },
  },
});

export const snoozeDialogContext = defineContext({
  id: 'snooze.dialog',
  displayName: 'Snooze',
  actions: {
    close: { displayName: 'Close', defaults: 'escape' },
    confirm: { displayName: 'Snooze', defaults: 'mod+enter' },
  },
});

export const confirmDialogContext = defineContext({
  id: 'confirm.dialog',
  displayName: 'Confirm',
  actions: {
    close: { displayName: 'Cancel', defaults: 'escape' },
  },
});

export const agentPickerContext = defineContext({
  id: 'agent.picker',
  displayName: 'Choose an agent',
  actions: {
    close: { displayName: 'Close', defaults: 'escape' },
  },
});

export const paletteContext = defineContext({
  id: 'palette',
  displayName: 'Palette',
  actions: {
    close: { displayName: 'Close palette', defaults: ['escape', 'mod+k'] },
  },
});

export type InboxListAction = (typeof inboxListContext.actionIds)[number];

export const MODAL_CONTEXT_IDS: ReadonlySet<string> = new Set(
  [snoozeDialogContext, agentPickerContext, confirmDialogContext].map((context) => context.id),
);

export function isModalOpen(snapshot: RegistrySnapshot): boolean {
  return snapshot.activations.some(({ contextId }) => MODAL_CONTEXT_IDS.has(contextId));
}

export const ALL_CONTEXTS: readonly ShortcutContext[] = [
  appContext,
  inboxListContext,
  snoozeDialogContext,
  agentPickerContext,
  confirmDialogContext,
  paletteContext,
];

export function createShortcutRegistry(): Promise<ShortcutRegistry> {
  return createRegistry({ contexts: ALL_CONTEXTS, platform: 'mac', store: memoryStore() });
}
