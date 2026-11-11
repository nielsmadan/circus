import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

const FOCUSABLE = 'input:not(:disabled), button:not(:disabled)';

function nextFocus(
  controls: readonly HTMLElement[],
  active: Element | null,
  backwards: boolean,
): HTMLElement | undefined {
  const first = controls[0];
  const last = controls[controls.length - 1];
  const index = controls.findIndex((control) => control === active);
  if (index === -1) return backwards ? last : first;
  if (backwards) return index === 0 ? last : undefined;
  return index === controls.length - 1 ? first : undefined;
}

export interface ModalProps {
  readonly role?: 'dialog' | 'alertdialog';
  readonly labelledBy: string;
  readonly panelClassName: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly onDismiss?: () => void;
  readonly children: ReactNode;
}

export function Modal({
  role = 'dialog',
  labelledBy,
  panelClassName,
  initialFocus,
  onDismiss,
  children,
}: ModalProps): ReactElement {
  const [opener] = useState(() => document.activeElement);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = panelRef.current;
    initialFocus?.current?.focus();
    return () => {
      // StrictMode's simulated unmount leaves the node attached; only a real close detaches it
      if (node?.isConnected) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener, initialFocus]);

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const target = nextFocus(controls, document.activeElement, event.shiftKey);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss?.();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={trapTab}
        className={`rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
