import { useState } from 'react';

const TABS = ['Enrich', 'Triage', 'Inbox', 'Harvest'] as const;
type Tab = (typeof TABS)[number];

function Panel({ tab }: { tab: Tab }) {
  if (tab === 'Inbox') return <p>Inbox placeholder</p>;
  return <p>Not built yet</p>;
}

export function App() {
  const [active, setActive] = useState<Tab>('Inbox');
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
    </div>
  );
}
