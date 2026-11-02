import type { ShortcutRegistry } from '@shortcutkit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appContext, createShortcutRegistry, inboxListContext } from './contexts';
import { attachInput } from '@shortcutkit/dom';

let registry: ShortcutRegistry;
let fired: string[];
let disposers: (() => void)[];
let detachInput: () => void;

beforeEach(async () => {
  registry = await createShortcutRegistry();
  fired = [];
  detachInput = attachInput(registry);
  disposers = [
    registry.activate(appContext, (action) => fired.push(`app/${action}`)),
    registry.activate(inboxListContext, (action) => fired.push(action)),
    detachInput,
  ];
});

afterEach(() => {
  disposers.forEach((dispose) => dispose());
  document.body.replaceChildren();
});

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function focusTextInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  document.body.append(input);
  input.focus();
  return input;
}

describe('Circus DOM shortcuts', () => {
  it('fires a bare-key action and prevents the default', () => {
    const event = press({ code: 'KeyE' });
    expect(fired).toEqual(['harvestArchive']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a bare key to a focused text input', () => {
    focusTextInput();
    const event = press({ code: 'KeyE' });
    expect(fired).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('fires Escape while a text input is focused', () => {
    focusTextInput();
    press({ code: 'Escape' });
    expect(fired).toEqual(['back']);
  });

  it('skips composing input', () => {
    press({ code: 'KeyE', isComposing: true });
    expect(fired).toEqual([]);
  });

  it('fires delete for shift+3', () => {
    press({ code: 'Digit3', shiftKey: true });
    expect(fired).toEqual(['delete']);
  });

  it('fires a non-repeating action once while the key is held', () => {
    press({ code: 'KeyE' });
    const held = press({ code: 'KeyE', repeat: true });
    expect(fired).toEqual(['harvestArchive']);
    expect(held.defaultPrevented).toBe(true);
  });

  it('fires the app palette shortcut', () => {
    press({ code: 'KeyK', metaKey: true });
    expect(fired).toEqual(['app/openPalette']);
  });

  it('stops listening once removed', () => {
    detachInput();
    const event = press({ code: 'KeyE' });
    expect(event.defaultPrevented).toBe(false);
  });
});
