import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileTreeView } from './FileTreeView';
import { FileEntry } from '../../../common/services/types';

const nodeFuncFiles: FileEntry[] = [
  { path: '.github/workflows/func-deploy.yaml', mode: '100644', content: '', type: 'blob' },
  { path: '.gitignore', mode: '100644', content: '', type: 'blob' },
  { path: 'README.md', mode: '100644', content: '', type: 'blob' },
  { path: 'func.yaml', mode: '100644', content: '', type: 'blob' },
  { path: 'index.js', mode: '100644', content: '', type: 'blob' },
  { path: 'package.json', mode: '100644', content: '', type: 'blob' },
  { path: 'test/integration.js', mode: '100644', content: '', type: 'blob' },
  { path: 'test/unit.js', mode: '100644', content: '', type: 'blob' },
];

describe('FileTreeView', () => {
  it('renders all file and directory names', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('.github')).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getByText('func.yaml')).toBeInTheDocument();
    expect(screen.getByText('index.js')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('renders directories before files', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const allText = document.body.textContent ?? '';
    const githubPos = allText.indexOf('.github');
    const testPos = allText.indexOf('test');
    const gitignorePos = allText.indexOf('.gitignore');

    expect(githubPos).toBeLessThan(gitignorePos);
    expect(testPos).toBeLessThan(gitignorePos);
  });

  it('renders nested files under their parent directory', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const testDir = screen.getByText('test').closest('[role="treeitem"]');
    const nestedItems = testDir?.querySelectorAll('[role="treeitem"]');
    const nestedNames = Array.from(nestedItems ?? []).map((el) => el.textContent?.trim());

    expect(nestedNames).toContain('integration.js');
    expect(nestedNames).toContain('unit.js');
  });

  it('renders deeply nested paths as nested directories', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('.github')).toBeInTheDocument();
    expect(screen.getByText('workflows')).toBeInTheDocument();
    expect(screen.getByText('func-deploy.yaml')).toBeInTheDocument();
  });

  it('renders multiple files under the same directory', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const testDir = screen.getByText('test');
    const testGroup = testDir.closest('[role="treeitem"]');
    const nested = testGroup?.querySelectorAll('[role="treeitem"]');

    expect(nested?.length).toBe(2);
  });

  it('shows placeholder when no files provided', () => {
    render(
      <FileTreeView files={[]} selectedPath={null} dirtyPaths={new Set()} onSelect={vi.fn()} />,
    );

    expect(screen.getByText('No files')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
  });

  it('does not call onSelect when placeholder is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <FileTreeView files={[]} selectedPath={null} dirtyPaths={new Set()} onSelect={onSelect} />,
    );

    await user.click(screen.getByText('No files'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('calls onSelect when a file is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByText('func.yaml'));

    expect(onSelect).toHaveBeenCalledWith('func.yaml');
  });

  it('does not call onSelect when a directory is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByText('test'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows loading state with spinner', () => {
    render(
      <FileTreeView
        files={[]}
        selectedPath={null}
        dirtyPaths={new Set()}
        isLoading
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Loading source...')).toBeInTheDocument();
    expect(screen.queryByText('No files')).not.toBeInTheDocument();
  });

  it('renders icons on both directory and file nodes', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const testDir = screen.getByText('test').closest('[role="treeitem"]');
    expect(testDir?.querySelector('.pf-v6-c-tree-view__node-icon')).toBeInTheDocument();

    const fileItem = screen.getByText('index.js').closest('[role="treeitem"]');
    expect(fileItem?.querySelector('.pf-v6-c-tree-view__node-icon')).toBeInTheDocument();
  });

  it('shows dirty indicator for modified files', () => {
    render(
      <FileTreeView
        files={nodeFuncFiles}
        selectedPath={null}
        dirtyPaths={new Set(['func.yaml'])}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(/func\.yaml \u25CF/)).toBeInTheDocument();
    expect(screen.queryByText(/index\.js \u25CF/)).not.toBeInTheDocument();
  });
});
