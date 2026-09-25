import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import {
  getFilesStub,
  listFunctionsStub,
  putFilesSpy,
  putFilesStub,
  repoListItem,
} from '../../common/testing/functionsClientStub';
import { FileEntry } from '../../common/types';
import FunctionEditPage from './FunctionEditPage';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the clusterStub available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let mockOnChange: ((value: string) => void) | undefined;

vi.mock('@openshift-console/dynamic-plugin-sdk', () => {
  const consoleFetchJSON = async (url: string, _method?: string, options?: RequestInit) => {
    const res = await fetch(new URL(url, 'http://localhost').href, options);
    const json = await res.json();
    if (!res.ok) throw json;
    return json;
  };

  const consoleFetch = async (url: string, options?: RequestInit) => {
    const res = await fetch(new URL(url, 'http://localhost').href, options);
    if (!res.ok) throw await res.json();
    return res;
  };

  return {
    DocumentTitle: ({ children }: { children: string }) => children,
    ListPageHeader: ({ title }: { title: string }) => title,
    CodeEditor: ({
      onChange,
      value,
      language,
      showEditor,
      emptyState,
    }: {
      onChange?: (value: string) => void;
      value?: string;
      language?: string;
      showEditor?: boolean;
      emptyState?: unknown;
    }) => {
      mockOnChange = onChange;
      if (!showEditor && emptyState) return emptyState;
      return (
        <div data-testid="code-editor" data-language={language ?? ''}>
          {value ?? ''}
        </div>
      );
    },
    consoleFetchJSON,
    consoleFetch,
    useActiveNamespace: sdkTestDoubles.useActiveNamespaceStub,
    isAllNamespacesKey: sdkTestDoubles.isAllNamespaceKeyFake,
  };
});

function renderEditPage(name: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/faas/edit/${name}` }]}>
      <Routes>
        <Route path="/faas/edit/:name" element={<FunctionEditPage />} />
        <Route path="/faas" element={<div>Functions list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FunctionEditPage', () => {
  beforeEach(() => {
    logoutGithubFake();
    authenticateGithubFake();
  });

  afterAll(() => {
    logoutGithubFake();
  });

  it('shows loading state in tree while fetching files', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    let continueWithRequest = () => {};
    getFilesStub({
      wait: new Promise<void>((r) => {
        continueWithRequest = r;
      }),
    });

    renderEditPage('my-func');

    expect(screen.getByText('Loading source...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();

    continueWithRequest();
    await waitFor(() => {
      expect(screen.getByText('No files')).toBeInTheDocument();
    });
  });

  it('loads files from backend', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });
  });

  it('shows empty tree and disabled save when repo not found', async () => {
    renderEditPage('nonexistent');

    await waitFor(() => {
      expect(screen.getByText('No files')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Back to Functions/ })).toBeInTheDocument();
  });

  it('shows info bar with function name and repo link after loading', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    const repoLink = screen.getByRole('link', { name: 'twoGiants/my-func' });
    expect(repoLink).toHaveAttribute('target', '_blank');
  });

  it('auto-selects handler file based on runtime from func.yaml', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      const indexItem = screen.getByText('index.js').closest('[role="treeitem"]');
      expect(indexItem).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('navigates back without modal when no changes made', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /Back to Functions/ }));

    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(screen.getByText('Functions list')).toBeInTheDocument();
  });

  it('shows selected file content in editor when tree item is clicked', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByText('func.yaml'));

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toHaveTextContent('name: my-func');
    });
  });

  it('marks hasChanges true after editing a file', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();

    act(() => mockOnChange?.('const x = 1;'));

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeEnabled();
  });

  it('resets hasChanges after save', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('const x = 1;'));
    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeEnabled();

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();
    });
  });

  it('persists edited content when switching files and back', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited module'));

    const user = userEvent.setup();
    await user.click(screen.getByText('func.yaml'));

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toHaveTextContent('name: my-func');
    });

    // After editing, dirty indicator appends a dot to the filename
    await user.click(screen.getByText(/^index\.js/));

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toHaveTextContent('edited module');
    });
  });

  it('updates editor language when selecting a different file type', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    expect(screen.getByTestId('code-editor')).toHaveAttribute('data-language', 'javascript');

    await userEvent.setup().click(screen.getByText('func.yaml'));

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toHaveAttribute('data-language', 'yaml');
    });
  });

  it.each([
    ['index.js', 'module.exports = async (context) => context;', 'javascript'],
    ['handler.ts', 'export const handle = (ctx: Context): void => {};', 'typescript'],
    ['main.go', 'package main\n\nfunc main() {}', 'go'],
    ['app.py', 'def main():\n    return "ok"', 'python'],
    ['func.yaml', 'name: my-func\nruntime: node', 'yaml'],
    ['config.yml', 'key: value', 'yaml'],
    ['package.json', '{"name": "my-func"}', 'json'],
    ['README.md', '# My Function', 'markdown'],
    ['Dockerfile', 'FROM registry.access.redhat.com/ubi9/nodejs-20', 'dockerfile'],
    ['.gitignore', 'node_modules/', 'plaintext'],
    ['Makefile', 'build:\n\tgo build .', 'plaintext'],
  ])('shows correct editor language for %s', async (path, content, expected) => {
    listFunctionsStub({ responses: [repoListItem()] });
    getFilesStub({ responses: [fileEntry(path, content)] });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText(path)).toBeInTheDocument();
    });

    // select the file
    await userEvent.setup().click(screen.getByText(path));

    expect(screen.getByTestId('code-editor')).toHaveAttribute('data-language', expected);
  });

  it('calls backend PUT when saving edited files', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByText('Pushed to GitHub. Deployment running...')).toBeInTheDocument();
    });
  });

  it('shows danger alert when save fails', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy({ errorResponse: { message: 'Server Error', status: 500 } });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByText('Server Error')).toBeInTheDocument();
    });
  });

  it('disables save button while saving is in progress', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy({ wait: new Promise(() => {}) });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();
    });
  });

  it('clears error alert when next save succeeds', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy({ errorResponse: { message: 'Server Error', status: 500 } });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByText('Server Error')).toBeInTheDocument();
    });

    putFilesSpy();

    act(() => mockOnChange?.('edited again'));
    await user.click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByText('Pushed to GitHub. Deployment running...')).toBeInTheDocument();
    });
  });

  it('shows empty state placeholder when no file is selected', async () => {
    renderEditPage('nonexistent');

    await waitFor(() => {
      expect(screen.getByText('No files')).toBeInTheDocument();
    });

    expect(screen.getByText('Start editing')).toBeInTheDocument();
    expect(
      screen.getByText('Select a file from the tree view to start editing.'),
    ).toBeInTheDocument();
  });

  it('shows success message after save and hides it after 2 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited content'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByText('Pushed to GitHub. Deployment running...')).toBeInTheDocument();
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText('Pushed to GitHub. Deployment running...')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('deletes a file from the tree when Delete File is clicked', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByLabelText('func.yaml actions'));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete File' }));

    await waitFor(() => {
      expect(screen.queryByText('func.yaml')).not.toBeInTheDocument();
    });
  });

  it('enables save button after deleting a file', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();

    await userEvent.setup().click(screen.getByLabelText('func.yaml actions'));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete File' }));

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeEnabled();
  });

  it('clears the editor when the selected file is deleted', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByText('func.yaml'));

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toHaveTextContent('name: my-func');
    });

    await userEvent.setup().click(screen.getByLabelText('func.yaml actions'));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete File' }));

    await waitFor(() => {
      expect(screen.getByText('Start editing')).toBeInTheDocument();
    });
  });

  // CONTINUE HERE: see msw recommendation
  // https://mswjs.io/docs/best-practices/avoid-request-assertions/#request-validity and
  // pi answer
  it.only('includes deleted files with deleted:true in the PUT request body', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesStub({ expectedRequest: { files: [], message: '', branch: '' } });

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByLabelText('func.yaml actions'));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete File' }));
    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    expect(screen.queryByText('func.yaml')).not.toBeInTheDocument();
  });

  it('resets deleted files after a successful save', async () => {
    listFunctionsStub({ responses: [repoListItem({ runtime: 'node' })] });
    getFilesStub({ responses: fileEntries() });
    putFilesSpy();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByLabelText('func.yaml actions'));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete File' }));

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeEnabled();

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();
    });
  });
});

// -----------------------------------------------------------------------------
// Test data factories ---------------------------------------------------------
// -----------------------------------------------------------------------------
function fileEntries(): FileEntry[] {
  return [
    {
      path: 'func.yaml',
      mode: '100644',
      content: 'name: my-func\nruntime: node',
      type: 'blob',
    },
    { path: 'index.js', mode: '100644', content: 'module.exports = {}', type: 'blob' },
  ];
}

function fileEntry(path: string, content: string): FileEntry {
  return {
    path,
    mode: '100644',
    content,
    type: 'blob',
  };
}
