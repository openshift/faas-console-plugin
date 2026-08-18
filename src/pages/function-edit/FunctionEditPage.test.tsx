import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../../testing/msw/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import FunctionEditPage from './FunctionEditPage';
import { BACKEND_API } from '../../../testing/setup';

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
  };
});

function renderEditPage(name: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/faas/edit/${name}` }]}>
      <Routes>
        <Route path="/faas/edit/:name" element={<FunctionEditPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setupListHandler() {
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/list`, () =>
      HttpResponse.json([
        {
          owner: 'twoGiants',
          repoName: 'my-func',
          repoURL: 'https://github.com/twoGiants/my-func',
          defaultBranch: 'main',
          name: 'my-func',
          namespace: 'demo',
          runtime: 'node',
        },
      ]),
    ),
  );
}

function setupFetchHandlers() {
  setupListHandler();
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, () =>
      HttpResponse.json([
        {
          path: 'func.yaml',
          mode: '100644',
          content: 'name: my-func\nruntime: node',
          type: 'blob',
        },
        { path: 'index.js', mode: '100644', content: 'module.exports = {}', type: 'blob' },
      ]),
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
    setupListHandler();
    server.use(
      http.get(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );

    renderEditPage('my-func');

    expect(screen.getByText('Loading source...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save & Deploy/ })).toBeDisabled();
  });

  it('loads files from backend', async () => {
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
    setupPutHandler();

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

    // After editing, dirty indicator appends a dot to the filename
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

  it('calls backend PUT when saving edited files', async () => {
    setupFetchHandlers();
    const putHandler = vi.fn();
    server.use(
      http.put(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, async ({ request }) => {
        putHandler(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderEditPage('my-func');

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    act(() => mockOnChange?.('edited'));

    await userEvent.setup().click(screen.getByRole('button', { name: /Save & Deploy/ }));

    await waitFor(() => {
      expect(putHandler).toHaveBeenCalled();
    });
  });

  it('shows danger alert when save fails', async () => {
    setupFetchHandlers();
    server.use(
      http.put(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, () =>
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
    server.use(
      http.put(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, async () => {
        await delay('infinite');
        return new HttpResponse(null, { status: 204 });
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

    server.use(
      http.put(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, () =>
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
      http.put(
        `${BACKEND_API}/api/v1/func/twoGiants/my-func/files`,
        () => new HttpResponse(null, { status: 204 }),
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
    setupPutHandler();

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

function setupPutHandler() {
  server.use(
    http.put(
      `${BACKEND_API}/api/v1/func/twoGiants/my-func/files`,
      () => new HttpResponse(null, { status: 204 }),
    ),
  );
}
