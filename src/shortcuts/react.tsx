// Temporary: replace with @shortcutkit/react once it exists.
import { shortcutLabel, type ShortcutContext, type ShortcutRegistry } from '@shortcutkit/core';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

const RegistryContext = createContext<ShortcutRegistry | null>(null);

export function ShortcutRegistryProvider(props: {
  registry: ShortcutRegistry;
  children: ReactNode;
}): ReactElement {
  return <RegistryContext value={props.registry}>{props.children}</RegistryContext>;
}

export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error('useShortcutRegistry needs a ShortcutRegistryProvider');
  return registry;
}

export function useShortcutContext<A extends string>(
  context: ShortcutContext<A>,
  handler: (action: A) => void,
  enabled = true,
): void {
  const registry = useShortcutRegistry();
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return registry.activate(context, (action) => latest.current(action));
  }, [registry, context, enabled]);
}

export function useShortcutLabel<A extends string>(
  context: ShortcutContext<A>,
  action: A,
): string | null {
  const registry = useShortcutRegistry();
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const first = registry.shortcuts(context, action)[0];
  return first ? shortcutLabel(first, { platform: 'mac' }) : null;
}
