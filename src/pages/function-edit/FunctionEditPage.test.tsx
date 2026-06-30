import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../../testing/msw/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import FunctionEditPage from './FunctionEditPage';

const GITHUB_API = 'https://api.github.com';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let mockOnChange: ((value: string) => void) | undefined;

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
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
}));

function renderEditPage(name: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/faas/edit/${name}` }]}>
      <Routes>
        <Route path="/faas/edit/:name" element={<FunctionEditPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setupSearchReposHandler() {
  server.use(
    http.get(`${GITHUB_API}/search/repositories`, () =>
      HttpResponse.json({
        total_count: 1,
        items: [
          {
            owner: { login: 'twoGiants' },
            name: 'my-func',
            html_url: 'https://github.com/twoGiants/my-func',
            default_branch: 'main',
          },
        ],
      }),
    ),
  );
}

function setupFetchHandlers() {
  setupSearchReposHandler();
  server.use(
    http.get(`${GITHUB_API}/repos/twoGiants/my-func/git/trees/main`, () =>
      HttpResponse.json({
        sha: 'tree-sha',
        tree: [
          { path: 'func.yaml', type: 'blob', mode: '100644', sha: 'blob-1' },
          { path: 'index.js', type: 'blob', mode: '100644', sha: 'blob-2' },
        ],
      }),
    ),
    http.get(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs/blob-1`, () =>
      HttpResponse.json({
        content: btoa('name: my-func\nruntime: node'),
        encoding: 'base64',
      }),
    ),
    http.get(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs/blob-2`, () =>
      HttpResponse.json({
        content: btoa('module.exports = {}'),
        encoding: 'base64',
      }),
    ),
  );
}

describe('FunctionEditPage', () => {
  beforeAll(() => {
    sessionStorage.setItem('func-console-pat', 'test-pat');
  });

  afterAll(() => {
    sessionStorage.clear();
  });

  it('shows loading state in tree while fetching files', () => {
    setupSearchReposHandler();
    server.use(
      http.get(`${GITHUB_API}/repos/twoGiants/my-func/git/trees/main`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );

    renderEditPage('my-func');

    expect(screen.getByText('Loading source...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();
  });

  it('loads files from GitHub', async () => {
    setupFetchHandlers();

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
    setupFetchHandlers();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    const repoLink = screen.getByRole('link', { name: 'twoGiants/my-func' });
    expect(repoLink).toHaveAttribute('target', '_blank');
  });

  it('auto-selects handler file based on runtime from func.yaml', async () => {
    setupFetchHandlers();

    renderEditPage('my-func');

    await waitFor(() => {
      const indexItem = screen.getByText('index.js').closest('[role="treeitem"]');
      expect(indexItem).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('navigates back without modal when no changes made', async () => {
    setupFetchHandlers();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /Back to Functions/ }));

    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('shows selected file content in editor when tree item is clicked', async () => {
    setupFetchHandlers();

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
    setupFetchHandlers();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();

    act(() => mockOnChange?.('const x = 1;'));

    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeEnabled();
  });

  it('resets hasChanges after save', async () => {
    setupFetchHandlers();
    setupPushHandlers();

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
    setupFetchHandlers();

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

    // After editing, dirty indicator appends ● to the filename
    await user.click(screen.getByText(/^index\.js/));

    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toHaveTextContent('edited module');
    });
  });

  it('updates editor language when selecting a different file type', async () => {
    setupFetchHandlers();

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

  it('calls GitHub push API when saving edited files', async () => {
    setupFetchHandlers();
    setupPushHandlers();

    const createTree = vi.fn();
    server.use(
      http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/trees`, async ({ request }) => {
        createTree(await request.json());
        return HttpResponse.json({ sha: 'tree-sha' });
      }),
    );

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(createTree).toHaveBeenCalled();
    });
  });

  it('shows danger alert when save fails', async () => {
    setupFetchHandlers();
    setupPushHandlers();
    server.use(
      http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs`, () =>
        HttpResponse.json({ message: 'Server Error' }, { status: 500 }),
      ),
    );

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
    setupFetchHandlers();
    setupPushHandlers();
    server.use(
      http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs`, async () => {
        await delay('infinite');
        return HttpResponse.json({ sha: 'blob-sha' });
      }),
    );

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
    setupFetchHandlers();
    setupPushHandlers();

    server.use(
      http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs`, () =>
        HttpResponse.json({ message: 'Server Error' }, { status: 500 }),
      ),
    );

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

    server.use(
      http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs`, () =>
        HttpResponse.json({ sha: 'blob-sha' }),
      ),
    );

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
    setupFetchHandlers();
    setupPushHandlers();

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('func.yaml')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited content'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(screen.getByText('Pushed to GitHub. Deployment running...')).toBeInTheDocument();
    });

    vi.advanceTimersByTime(2000);

    await waitFor(() => {
      expect(screen.queryByText('Pushed to GitHub. Deployment running...')).not.toBeInTheDocument();
    });

    vi.useRealTimers();
  });
});

function setupPushHandlers() {
  setupSearchReposHandler();
  server.use(
    http.get(`${GITHUB_API}/repos/twoGiants/my-func/git/ref/:ref+`, () =>
      HttpResponse.json({ object: { sha: 'head-sha' } }),
    ),
    http.get(`${GITHUB_API}/repos/twoGiants/my-func/git/commits/:sha`, () =>
      HttpResponse.json({ tree: { sha: 'parent-tree-sha' } }),
    ),
    http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/blobs`, () =>
      HttpResponse.json({ sha: 'blob-sha' }),
    ),
    http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/trees`, () =>
      HttpResponse.json({ sha: 'tree-sha' }),
    ),
    http.post(`${GITHUB_API}/repos/twoGiants/my-func/git/commits`, () =>
      HttpResponse.json({ sha: 'commit-sha' }),
    ),
    http.patch(`${GITHUB_API}/repos/twoGiants/my-func/git/refs/:ref+`, () => HttpResponse.json({})),
  );
}
