import type { ShortcutRegistry } from '@shortcutkit/core';
import type { ReactNode } from 'react';
import { createShortcutRegistry } from '../shortcuts/contexts';
import { installKeyboardHost } from '../shortcuts/keyboard-host';
import { ShortcutRegistryProvider } from '../shortcuts/react';

export interface ShortcutHarness {
  readonly registry: ShortcutRegistry;
  readonly wrapper: (props: { children: ReactNode }) => ReactNode;
  readonly dispose: () => void;
}

export async function shortcutHarness(): Promise<ShortcutHarness> {
  const registry = await createShortcutRegistry();
  const dispose = installKeyboardHost(registry, window);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ShortcutRegistryProvider registry={registry}>{children}</ShortcutRegistryProvider>
  );
  return { registry, wrapper, dispose };
}
