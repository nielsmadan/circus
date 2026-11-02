import type { ShortcutRegistry } from '@shortcutkit/core';
import type { ReactNode } from 'react';
import { createShortcutRegistry } from '../shortcuts/contexts';
import { ShortcutKitProvider } from '@shortcutkit/react';

export interface ShortcutHarness {
  readonly registry: ShortcutRegistry;
  readonly wrapper: (props: { children: ReactNode }) => ReactNode;
}

export async function shortcutHarness(): Promise<ShortcutHarness> {
  const registry = await createShortcutRegistry();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ShortcutKitProvider registry={registry}>{children}</ShortcutKitProvider>
  );
  return { registry, wrapper };
}
