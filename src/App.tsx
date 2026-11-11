import { useCallback, useState } from 'react';
import type { CircusApi } from './api/client';
import type { CircusError } from './api/types';
import { FinishingOverlay } from './inbox/FinishingOverlay';
import { InboxView } from './inbox/InboxView';
import { errorDetail, presenceOffToast } from './inbox/messages';
import { Toasts } from './inbox/Toasts';
import { useInbox } from './inbox/useInbox';
import { SetupScreen } from './setup/SetupScreen';
import { UpdateBanner } from './setup/UpdateBanner';
import { needsSetup, offersUpdate, useSetup } from './setup/useSetup';
import { CommandPalette } from './palette/CommandPalette';
import { appContext, isModalOpen } from './shortcuts/contexts';

import { useRegistry, useShortcutContext } from '@shortcutkit/react';

const TABS = ['Inbox', 'Archive', 'Harvests'] as const;
type Tab = (typeof TABS)[number];
type AppAction = (typeof appContext.actionIds)[number];

const TAB_FOR_ACTION: Readonly<Partial<Record<AppAction, Tab>>> = {
  goInbox: 'Inbox',
  goArchive: 'Archive',
  goHarvests: 'Harvests',
};

export function App({ api }: { readonly api: CircusApi }) {
  const controller = useInbox(api);
  const setup = useSetup(api);
  const [updateLater, setUpdateLater] = useState(false);
  const showSetup = needsSetup(setup.status, setup.prefs, controller.loadError?.kind ?? null);
  const { refresh, rescan, notify } = controller;
  const onSetupDone = useCallback(
    (presenceError: CircusError | null) => {
      if (presenceError !== null) notify(presenceOffToast(errorDetail(presenceError)));
      refresh();
      rescan();
    },
    [notify, refresh, rescan],
  );
  const onUpdateLater = useCallback(() => setUpdateLater(true), []);
  const registry = useRegistry();
  const [active, setActive] = useState<Tab>('Inbox');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openHarvests = useCallback(() => setActive('Harvests'), []);
  useShortcutContext(
    appContext,
    (action) => {
      if (action === 'openPalette') {
        if (!isModalOpen(registry.getSnapshot())) setPaletteOpen(true);
        return;
      }
      const tab = TAB_FOR_ACTION[action];
      if (tab) setActive(tab);
    },
    { enabled: !showSetup },
  );
  if (showSetup) {
    return (
      <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <SetupScreen setup={setup} onDone={onSetupDone} />
        <Toasts controller={controller} />
        <FinishingOverlay controller={controller} />
      </div>
    );
  }
  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {offersUpdate(setup.status, setup.prefs) && !updateLater && (
        <UpdateBanner
          status={setup.status}
          updating={setup.busy === 'ringleader'}
          disabled={setup.busy !== null}
          error={setup.failure?.step === 'ringleader' ? setup.failure.error : null}
          onUpdate={setup.installRingleader}
          onLater={onUpdateLater}
          onStopAsking={setup.stopPrompting}
        />
      )}
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div role="tablist" aria-label="Sections" className="flex gap-2">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`tab-${tab}`}
              aria-selected={tab === active}
              aria-controls={`panel-${tab}`}
              onClick={() => setActive(tab)}
              className="rounded px-2 py-1 text-sm aria-selected:bg-blue-500/15 aria-selected:font-medium"
            >
              {tab}
            </button>
          ))}
        </div>
      </header>
      {TABS.map((tab) => (
        <main
          key={tab}
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          hidden={tab !== active}
          className={tab === 'Inbox' ? 'flex min-h-0 flex-1 flex-col' : 'flex-1 p-4'}
        >
          {tab === 'Inbox' ? (
            <InboxView
              controller={controller}
              api={api}
              visible={active === 'Inbox'}
              onOpenHarvests={openHarvests}
            />
          ) : (
            <p>Not built yet</p>
          )}
        </main>
      ))}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toasts controller={controller} />
      <FinishingOverlay controller={controller} />
    </div>
  );
}
