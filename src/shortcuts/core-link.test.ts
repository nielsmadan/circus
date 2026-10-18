import { createRegistry, defineContext, memoryStore } from '@shortcutkit/core';
import { describe, expect, it } from 'vitest';

describe('@shortcutkit/core link', () => {
  it('fires a handler for a default binding', async () => {
    const ctx = defineContext({
      id: 't',
      actions: { go: { displayName: 'Go', defaults: 'mod+k' } },
    });
    const registry = await createRegistry({
      contexts: [ctx],
      platform: 'mac',
      store: memoryStore(),
    });
    const received: string[] = [];
    registry.activate(ctx, (action) => received.push(action));
    const result = registry.handleInput({
      type: 'key',
      code: 'KeyK',
      modifiers: { ctrl: false, alt: false, shift: false, meta: true },
    });
    expect(result).toBe('fired');
    expect(received).toEqual(['go']);
  });
});
