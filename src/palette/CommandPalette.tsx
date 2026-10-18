import {
  filterKeyBindings,
  shortcutLabel,
  type KeyBindingEntry,
  type KeyBindings,
} from '@shortcutkit/core';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { appContext, paletteContext, snoozeDialogContext } from '../shortcuts/contexts';
import { useShortcutContext, useShortcutRegistry } from '../shortcuts/react';

export interface PaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

interface PaletteItem {
  readonly entry: KeyBindingEntry;
  readonly group: string;
  readonly label: string | null;
}

const HIDDEN_GROUPS: ReadonlySet<string> = new Set([paletteContext.id, snoozeDialogContext.id]);

function paletteBindings(bindings: KeyBindings): KeyBindings {
  const groups = bindings.groups
    .filter((group) => !HIDDEN_GROUPS.has(group.contextId))
    .map((group) => ({
      ...group,
      entries: group.entries.filter(
        (entry) => !(entry.contextId === appContext.id && entry.actionId === 'openPalette'),
      ),
    }));
  return { groups };
}

function paletteItems(bindings: KeyBindings, query: string): PaletteItem[] {
  return filterKeyBindings(paletteBindings(bindings), query).groups.flatMap((group) =>
    group.entries.map((entry) => {
      const first = entry.shortcuts[0];
      return {
        entry,
        group: group.displayName,
        label: first ? shortcutLabel(first, { platform: 'mac' }) : null,
      };
    }),
  );
}

const OWNED_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab']);

export function CommandPalette(props: PaletteProps): ReactElement | null {
  useShortcutContext(paletteContext, props.onClose, props.open);
  return props.open ? <PaletteBody onClose={props.onClose} /> : null;
}

function PaletteBody({ onClose }: { readonly onClose: () => void }): ReactElement {
  const registry = useShortcutRegistry();
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [opener] = useState(() => document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = dialogRef.current;
    return () => {
      if (node?.isConnected) return;
      const focusLost = document.activeElement === null || document.activeElement === document.body;
      if (focusLost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);
  const items = paletteItems(registry.activeBindings(), query);
  const current = Math.min(highlight, Math.max(items.length - 1, 0));

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    registry.dispatchRef({ contextId: item.entry.contextId, actionId: item.entry.actionId });
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!OWNED_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const count = items.length;
    if (event.key === 'ArrowDown' && count > 0) setHighlight((current + 1) % count);
    if (event.key === 'ArrowUp' && count > 0) setHighlight((current - 1 + count) % count);
    if (event.key === 'Enter') run(items[current]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => {
          if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
        }}
        className="w-[32rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-white shadow-xl dark:bg-neutral-900"
      >
        <input
          type="text"
          aria-label="Search commands"
          placeholder="Type a command…"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          className="w-full border-b bg-transparent px-4 py-3 outline-none"
        />
        {items.length === 0 ? (
          <p className="px-4 py-3 text-sm opacity-70">No matching commands</p>
        ) : (
          <ul role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto py-1">
            {items.map((item, index) => (
              <li
                key={item.entry.id}
                role="option"
                aria-selected={index === current}
                ref={
                  index === current
                    ? (element) => element?.scrollIntoView?.({ block: 'nearest' })
                    : undefined
                }
                onClick={() => run(item)}
                className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm aria-selected:bg-blue-500/15"
              >
                <span className="flex-1">{item.entry.displayName}</span>
                <span className="text-xs opacity-60">{item.group}</span>
                {item.label && <kbd className="font-mono text-xs">{item.label}</kbd>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
