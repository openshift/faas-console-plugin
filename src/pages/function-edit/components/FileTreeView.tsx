import { useMemo } from 'react';
import { Spinner, TreeView, TreeViewDataItem } from '@patternfly/react-core';
import { FileIcon, FolderIcon, FolderOpenIcon } from '@patternfly/react-icons';
import { FileEntry } from '../../../common/services/types';
import * as React from 'react';

const emptyTreeData: TreeViewDataItem[] = [{ id: '__empty__', name: 'No files' }];
const loadingTreeData: TreeViewDataItem[] = [
  {
    id: '__loading__',
    name: (
      <>
        <Spinner size="sm" /> Loading source...
      </>
    ),
  },
];

interface FileTreeViewProps {
  files: FileEntry[];
  selectedPath: string | null;
  dirtyPaths: Set<string>;
  isLoading?: boolean;
  onSelect: (path: string) => void;
}

export const FileTreeView = React.memo(function FileTreeView({
  files,
  selectedPath,
  dirtyPaths,
  isLoading = false,
  onSelect,
}: FileTreeViewProps) {
  const { treeData, activeItems, handleSelect, selectable } = useFileTreeView(
    files,
    selectedPath,
    dirtyPaths,
    isLoading,
    onSelect,
  );

  return (
    <TreeView
      aria-label="File tree"
      data={treeData}
      activeItems={activeItems}
      onSelect={selectable ? handleSelect : undefined}
      hasGuides
    />
  );
});

// --- hook ---

function useFileTreeView(
  files: FileEntry[],
  selectedPath: string | null,
  dirtyPaths: Set<string>,
  isLoading: boolean = false,
  onSelect: (path: string) => void,
): {
  treeData: TreeViewDataItem[];
  activeItems: TreeViewDataItem[];
  handleSelect: (_: React.MouseEvent, item: TreeViewDataItem) => void;
  selectable: boolean;
} {
  const treeData = useMemo(() => buildFileTree(files, dirtyPaths), [files, dirtyPaths]);

  const activeItems = useMemo(() => {
    if (!selectedPath) return [];
    return findItemByPath(treeData, selectedPath);
  }, [treeData, selectedPath]);

  const handleSelect = (_: React.MouseEvent, item: TreeViewDataItem) => {
    if (!item.children) {
      onSelect(item.id!);
    }
  };

  let data: TreeViewDataItem[];
  if (isLoading) data = loadingTreeData;
  else if (treeData.length > 0) data = treeData;
  else data = emptyTreeData;

  const selectable = !isLoading && treeData.length > 0;

  return { treeData: data, activeItems, handleSelect, selectable };
}

// --- helpers ---
function findItemByPath(items: TreeViewDataItem[], path: string): TreeViewDataItem[] {
  for (const item of items) {
    if (item.id === path) return [item];
    if (item.children) {
      const found = findItemByPath(item.children, path);
      if (found.length > 0) return [item, ...found];
    }
  }
  return [];
}

function buildFileTree(files: FileEntry[], dirtyPaths: Set<string>): TreeViewDataItem[] {
  const root: TreeViewDataItem[] = [];

  for (const file of files) {
    if (isRootFile(file)) handleRootFile(file);
    else handleNestedFile(file);
  }

  sortTree(root);
  return root;

  function isRootFile(file: FileEntry): boolean {
    return file.path.split('/').length === 1;
  }

  function handleRootFile(file: FileEntry) {
    if (!root.find((item) => item.id === file.path)) createItem(file.path, file.path, root);
  }

  function handleNestedFile(file: FileEntry) {
    let items = root;
    const filePathParts = file.path.split('/');
    for (let i = 0; i < filePathParts.length; i++) {
      // e.g. with ['test/unit.js'] filePathPart is first 'test', then 'unit.js'
      const filePathPart = filePathParts[i];
      // fullPath is used as id
      const fullPath = filePathParts.slice(0, i + 1).join('/');
      // tells us if filePathPart we're working with is a dir or a file
      const isDir = i < filePathParts.length - 1;

      const existing = items.find((item) => item.id === fullPath);
      if (existing) {
        // only true when it's a directory and then we step into it
        items = existing.children!;
        continue;
      }

      createItem(fullPath, filePathPart, items, isDir);
      if (isDir) items = items[items.length - 1].children!;
    }
  }

  function createItem(id: string, name: string, items: TreeViewDataItem[], isDir = false) {
    const item: TreeViewDataItem = {
      id,
      name: dirtyPaths.has(id) ? `${name} \u25CF` : name,
      defaultExpanded: true,
    };
    if (isDir) {
      item.children = [];
      item.icon = <FolderIcon />;
      item.expandedIcon = <FolderOpenIcon />;
    } else {
      item.icon = <FileIcon />;
    }
    items.push(item);
  }

  function sortTree(items: TreeViewDataItem[]) {
    items.sort((a, b) => {
      const aIsDir = !!a.children;
      const bIsDir = !!b.children;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
    for (const item of items) {
      if (item.children) sortTree(item.children);
    }
  }
}
