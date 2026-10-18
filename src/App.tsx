import { useState } from 'react';
import type { CircusApi } from './api/client';
import { FinishingOverlay } from './inbox/FinishingOverlay';
import { InboxView } from './inbox/InboxView';
import { Toasts } from './inbox/Toasts';
import { useInbox } from './inbox/useInbox';
import { CommandPalette } from './palette/CommandPalette';
import { appContext } from './shortcuts/contexts';
import { useShortcutContext } from './shortcuts/react';

const TABS = ['Enrich', 'Triage', 'Inbox', 'Harvest'] as const;
type Tab = (typeof TABS)[number];
type AppAction = (typeof appContext.actionIds)[number];

const TAB_FOR_ACTION: Readonly<Partial<Record<AppAction, Tab>>> = {
  goEnrich: 'Enrich',
  goTriage: 'Triage',
  goInbox: 'Inbox',
  goHarvest: 'Harvest',
};

export function App({ api }: { readonly api: CircusApi }) {
  const controller = useInbox(api);
  const [active, setActive] = useState<Tab>('Inbox');
  const [paletteOpen, setPaletteOpen] = useState(false);
  useShortcutContext(appContext, (action) => {
    if (action === 'openPalette') {
      setPaletteOpen(true);
      return;
    }
    const tab = TAB_FOR_ACTION[action];
    if (tab) setActive(tab);
  });
  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
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
            <InboxView controller={controller} api={api} visible={active === 'Inbox'} />
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
