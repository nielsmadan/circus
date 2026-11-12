import { memo, type ReactElement } from 'react';
import { KeepFocusButton } from './KeepFocusButton';
import { under, type Scope } from './scope';
import { Entry } from './Entry';
import type { FolderNode } from './sidebarGroups';

const OPEN_DEPTH = 1;

export function isOpen(
  node: FolderNode,
  depth: number,
  choices: ReadonlyMap<string, boolean>,
): boolean {
  return choices.get(node.path) ?? depth <= OPEN_DEPTH;
}

interface BranchProps {
  readonly nodes: readonly FolderNode[];
  readonly depth: number;
  readonly selectedKey: string | null;
  readonly choices: ReadonlyMap<string, boolean>;
  readonly onScope: (scope: Scope | null) => void;
  readonly onOpen: (path: string, open: boolean) => void;
}

interface NodeProps extends Omit<BranchProps, 'nodes'> {
  readonly node: FolderNode;
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  selectedKey,
  choices,
  onScope,
  onOpen,
}: NodeProps): ReactElement {
  const current = selectedKey === node.path;
  const parent = node.children.length > 0;
  const open = parent && isOpen(node, depth, choices);
  return (
    <li>
      <div className="flex min-w-0 items-center" style={{ paddingLeft: `${depth * 12}px` }}>
        {parent ? (
          <KeepFocusButton
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => onOpen(node.path, !open)}
            className="flex h-5 w-4 shrink-0 items-center justify-center text-xs opacity-70 hover:opacity-100"
          >
            {open ? '▾' : '▸'}
          </KeepFocusButton>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <Entry
            label={node.name}
            detail={null}
            count={node.total}
            current={current}
            title={node.path}
            onClick={() => onScope(current ? null : node.scope)}
          />
        </div>
      </div>
      {open && (
        <ul className="flex flex-col gap-px">
          <Branch
            nodes={node.children}
            depth={depth + 1}
            selectedKey={selectedKey}
            choices={choices}
            onScope={onScope}
            onOpen={onOpen}
          />
        </ul>
      )}
    </li>
  );
});

function Branch({ nodes, selectedKey, ...rest }: BranchProps): ReactElement {
  return (
    <>
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          selectedKey={selectedKey !== null && under(selectedKey, node.path) ? selectedKey : null}
          {...rest}
        />
      ))}
    </>
  );
}

export interface FolderTreeProps {
  readonly roots: readonly FolderNode[];
  readonly scope: Scope | null;
  readonly choices: ReadonlyMap<string, boolean>;
  readonly onScope: (scope: Scope | null) => void;
  readonly onOpen: (path: string, open: boolean) => void;
}

export const FolderTree = memo(function FolderTree({
  roots,
  scope,
  choices,
  onScope,
  onOpen,
}: FolderTreeProps): ReactElement {
  return (
    <Branch
      nodes={roots}
      depth={0}
      selectedKey={scope?.kind === 'tree' ? scope.key : null}
      choices={choices}
      onScope={onScope}
      onOpen={onOpen}
    />
  );
});
