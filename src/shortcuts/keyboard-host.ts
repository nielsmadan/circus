// Temporary: replace with @shortcutkit/dom once it exists.
import type { ShortcutInput, ShortcutRegistry } from '@shortcutkit/core';

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'password',
  'number',
  'tel',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

export function isEditingTarget(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  // jsdom does not implement isContentEditable, so the attribute is checked too.
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.closest('[contenteditable]:not([contenteditable="false"])') !== null)
  );
}

export function toShortcutInput(event: KeyboardEvent, editingText: boolean): ShortcutInput {
  return {
    type: 'key',
    code: event.code,
    modifiers: {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
    repeat: event.repeat,
    editingText,
  };
}

export function installKeyboardHost(registry: ShortcutRegistry, target: Window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    const editing = isEditingTarget(target.document.activeElement);
    if (registry.handleInput(toShortcutInput(event, editing)) !== 'ignored') {
      event.preventDefault();
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
