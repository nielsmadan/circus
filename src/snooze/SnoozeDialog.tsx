import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { snoozeDialogContext } from '../shortcuts/contexts';
import { useShortcutContext } from '../shortcuts/react';
import { formatSnoozeTime, parseSnooze, SNOOZE_PRESETS, type SnoozeParse } from './parse';

export interface SnoozeDialogProps {
  readonly sessionLabel: string;
  readonly now: () => Date;
  readonly onConfirm: (at: Date) => void;
  readonly onClose: () => void;
}

type Source = 'text' | 'picker';

const FOCUSABLE = 'input:not(:disabled), button:not(:disabled)';
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const EMPTY_PREVIEW_CLASS = 'min-h-5 text-sm';

function parsePicker(value: string, now: Date): SnoozeParse | null {
  if (value === '') return null;
  const match = LOCAL_DATETIME.exec(value);
  if (!match) return { ok: false, error: 'Pick a valid date and time' };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const at = new Date(year ?? 0, (month ?? 1) - 1, day, hour, minute);
  const roundTrips =
    at.getFullYear() === year &&
    at.getMonth() === (month ?? 1) - 1 &&
    at.getDate() === day &&
    at.getHours() === hour &&
    at.getMinutes() === minute;
  if (!roundTrips) return { ok: false, error: 'Pick a valid date and time' };
  return at.getTime() > now.getTime()
    ? { ok: true, at }
    : { ok: false, error: 'That time has already passed' };
}

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

export function SnoozeDialog(props: SnoozeDialogProps): ReactElement {
  const [openedAt] = useState(() => props.now());
  const [opener] = useState(() => document.activeElement);
  const presets = useMemo(
    () =>
      SNOOZE_PRESETS.map((preset) => ({
        preset,
        parsed: parseSnooze(preset.phrase, openedAt),
      })),
    [openedAt],
  );
  const [text, setText] = useState('');
  const [picker, setPicker] = useState('');
  const [source, setSource] = useState<Source>('text');
  const confirmed = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = dialogRef.current;
    return () => {
      // StrictMode's simulated unmount leaves the node attached; only a real close detaches it
      if (node?.isConnected) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  const now = props.now();
  const textParse = text.trim() === '' ? null : parseSnooze(text, now);
  const pickerParse = parsePicker(picker, now);
  const selection =
    source === 'text' && text.trim() !== '' ? textParse : (pickerParse ?? textParse);

  const confirm = (at: Date) => {
    if (confirmed.current || at.getTime() <= props.now().getTime()) return;
    confirmed.current = true;
    props.onConfirm(at);
  };
  const confirmSelection = () => {
    if (selection?.ok) confirm(selection.at);
  };

  useShortcutContext(snoozeDialogContext, (action) => {
    if (action === 'close') props.onClose();
    else confirmSelection();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="snooze-title"
        onKeyDown={onKeyDown}
        className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-white p-4 shadow-xl dark:bg-neutral-900"
      >
        <h2 id="snooze-title" className="mb-3 text-base font-medium">
          Snooze “{props.sessionLabel}” until…
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmSelection();
          }}
        >
          <input
            type="text"
            aria-label="Snooze until"
            placeholder="Try “tomorrow 9am”, “3d”, “fri”"
            autoFocus
            aria-describedby="snooze-text-preview"
            onFocus={() => setSource('text')}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setSource('text');
            }}
            className="w-full rounded border bg-transparent px-3 py-2 outline-none"
          />
          <p
            id="snooze-text-preview"
            aria-live="polite"
            className={`${EMPTY_PREVIEW_CLASS} ${textParse && !textParse.ok ? 'text-red-600' : 'opacity-80'}`}
          >
            {textParse?.ok ? formatSnoozeTime(textParse.at, now) : (textParse?.error ?? '')}
          </p>
          <div className="my-2 flex flex-col gap-1">
            {presets.map(({ preset, parsed }) => (
              <button
                key={preset.id}
                type="button"
                disabled={!parsed.ok || parsed.at.getTime() <= now.getTime()}
                onClick={() => parsed.ok && confirm(parsed.at)}
                className="flex items-center justify-between rounded px-3 py-1.5 text-left text-sm hover:bg-blue-500/15 disabled:opacity-40"
              >
                <span>{preset.label}</span>
                <span className="text-xs opacity-70">
                  {parsed.ok ? formatSnoozeTime(parsed.at, openedAt) : ''}
                </span>
              </button>
            ))}
          </div>
          <label className="mb-1 block text-sm">
            Pick date &amp; time
            <input
              type="datetime-local"
              aria-describedby="snooze-picker-preview"
              onFocus={() => setSource('picker')}
              value={picker}
              onChange={(event) => {
                setPicker(event.target.value);
                setSource('picker');
              }}
              className="mt-1 block w-full rounded border bg-transparent px-3 py-2"
            />
          </label>
          <p
            id="snooze-picker-preview"
            aria-live="polite"
            className={`${EMPTY_PREVIEW_CLASS} ${pickerParse && !pickerParse.ok ? 'text-red-600' : 'opacity-80'}`}
          >
            {pickerParse?.ok ? formatSnoozeTime(pickerParse.at, now) : (pickerParse?.error ?? '')}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={props.onClose} className="rounded px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selection?.ok}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Snooze
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
