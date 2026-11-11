import { memo, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import type { CircusError, SessionRow, TailItem } from '../api/types';
import { chunkTail } from './tails';

export interface ConversationProps {
  readonly row: SessionRow;
  readonly item: TailItem | undefined;
  readonly error: CircusError | null;
}

const SKELETON_WIDTHS = ['92%', '78%', '85%', '64%', '88%', '52%'] as const;

const CHUNK_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 600px',
} as const;

function Skeleton(): ReactElement {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 py-2">
      <span className="sr-only">Loading conversation…</span>
      {SKELETON_WIDTHS.map((width, at) => (
        <div
          key={at}
          aria-hidden="true"
          className="h-3 rounded bg-neutral-300/60 dark:bg-neutral-700/60"
          style={{ width }}
        />
      ))}
    </div>
  );
}

function Problem({
  text,
  detail,
}: {
  readonly text: string;
  readonly detail: string;
}): ReactElement {
  return (
    <div className="text-sm">
      <p>{text}</p>
      <details className="text-xs opacity-70">
        <summary className="cursor-default">Details</summary>
        <p className="whitespace-pre-wrap">{detail}</p>
      </details>
    </div>
  );
}

function Transcript({ item }: { readonly item: TailItem }): ReactElement {
  const chunks = useMemo(() => chunkTail(item.text), [item]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [item]);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {item.truncated && (
        <p className="text-xs opacity-70">
          Showing the last {item.max_chars.toLocaleString('en-US')} characters — older messages
          aren’t shown here
        </p>
      )}
      <div
        ref={scrollRef}
        data-testid="conversation-scroll"
        className="max-h-[32rem] min-h-0 overflow-y-auto rounded border border-neutral-200 p-2 dark:border-neutral-800"
      >
        {chunks.map((chunk, at) => (
          <pre
            key={at}
            className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
            style={at === chunks.length - 1 ? undefined : CHUNK_STYLE}
          >
            {chunk}
          </pre>
        ))}
      </div>
    </div>
  );
}

function ConversationBody({ row, item, error }: ConversationProps): ReactElement {
  if (item === undefined) {
    if (error !== null) {
      return <Problem text="Couldn’t load the conversation" detail={error.message} />;
    }
    return <Skeleton />;
  }
  const stale = item.mtime !== row.mtime || item.file_fingerprint !== row.file_fingerprint;
  return (
    <>
      {error !== null && (
        <Problem text="Couldn’t refresh the conversation" detail={error.message} />
      )}
      {stale && (
        <p className="text-xs opacity-70">
          May be out of date — the session changed since this was read
        </p>
      )}
      {item.unavailable === null ? (
        <Transcript item={item} />
      ) : (
        <Problem text="Conversation unavailable" detail={item.unavailable} />
      )}
    </>
  );
}

export const Conversation = memo(
  function Conversation(props: ConversationProps): ReactElement {
    return (
      <section aria-label="Conversation" className="flex min-h-0 flex-col gap-2">
        <p className="text-sm font-semibold opacity-70">Conversation</p>
        <ConversationBody {...props} />
      </section>
    );
  },
  (before, after) =>
    before.item === after.item &&
    before.error === after.error &&
    before.row.session_id === after.row.session_id &&
    before.row.mtime === after.row.mtime &&
    before.row.file_fingerprint === after.row.file_fingerprint,
);
