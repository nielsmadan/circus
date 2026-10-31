import { memo, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { inboxListContext } from '../shortcuts/contexts';
import { useShortcutLabel } from '../shortcuts/react';

export interface SearchBoxProps {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onDone: () => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

export const SearchBox = memo(function SearchBox({
  query,
  onQuery,
  onDone,
  inputRef,
}: SearchBoxProps): ReactElement {
  const label = useShortcutLabel(inboxListContext, 'search');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    onDone();
  };
  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        aria-label="Search sessions"
        placeholder="Search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        className="w-64 rounded border border-neutral-300 bg-transparent px-2 py-1 pr-7 text-sm outline-none focus:border-blue-500 dark:border-neutral-700"
      />
      {label && query === '' && (
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-xs opacity-60">
          {label}
        </kbd>
      )}
    </div>
  );
});
