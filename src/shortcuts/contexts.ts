import {
  createRegistry,
  defineContext,
  memoryStore,
  type ShortcutContext,
  type ShortcutRegistry,
} from '@shortcutkit/core';

export const appContext = defineContext({
  id: 'app',
  displayName: 'App',
  actions: {
    goEnrich: { displayName: 'Go to Enrich', defaults: 'mod+1' },
    goTriage: { displayName: 'Go to Triage', defaults: 'mod+2' },
    goInbox: { displayName: 'Go to Inbox', defaults: 'mod+3' },
    goHarvest: { displayName: 'Go to Harvest', defaults: 'mod+4' },
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
    undo: { displayName: 'Undo', defaults: 'z', allowsKeyRepeat: false },
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

export const paletteContext = defineContext({
  id: 'palette',
  displayName: 'Palette',
  actions: {
    close: { displayName: 'Close palette', defaults: ['escape', 'mod+k'] },
  },
});

export type InboxListAction = (typeof inboxListContext.actionIds)[number];

export const ALL_CONTEXTS: readonly ShortcutContext[] = [
  appContext,
  inboxListContext,
  snoozeDialogContext,
  paletteContext,
];

export function createShortcutRegistry(): Promise<ShortcutRegistry> {
  return createRegistry({ contexts: ALL_CONTEXTS, platform: 'mac', store: memoryStore() });
}
