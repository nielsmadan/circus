import { useState } from 'react';
import type { CircusApi } from './api/client';
import { FinishingOverlay } from './inbox/FinishingOverlay';
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

function Panel({ tab }: { tab: Tab }) {
  if (tab === 'Inbox') return <p>Inbox placeholder</p>;
  return <p>Not built yet</p>;
}

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
    <div className="flex h-screen flex-col">
      <header className="border-b px-4 py-2">
        <div role="tablist" className="flex gap-2">
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
          className="flex-1 p-4"
        >
          <Panel tab={tab} />
        </main>
      ))}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toasts controller={controller} />
      <FinishingOverlay controller={controller} />
    </div>
  );
}
