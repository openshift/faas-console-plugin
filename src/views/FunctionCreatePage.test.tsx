import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import FunctionCreatePage from './FunctionCreatePage';
import { PAT_KEY, USER_KEY } from '../services/types';

const mockGenerateFunction = vi.fn();
const mockCreateRepoWithSecret = vi.fn();
const mockGenerateKubeconfig = vi.fn();
const mockNavigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  DocumentTitle: ({ children }: { children: string }) => children,
  ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <>
      {title}
      {children}
    </>
  ),
}));

vi.mock('../services/function/useFunctionService', () => ({
  useFunctionService: () => ({ generateFunction: mockGenerateFunction }),
}));

vi.mock('../services/source-control/useSourceControlService', () => ({
  useSourceControlService: () => ({
    createRepoWithSecret: mockCreateRepoWithSecret,
    listFunctionRepos: vi.fn(),
    fetchFileContent: vi.fn(),
  }),
}));

vi.mock('../services/cluster/useClusterService', () => ({
  useClusterService: () => ({
    deployments: [],
    loaded: true,
    error: undefined,
    generateKubeconfig: mockGenerateKubeconfig,
  }),
}));

vi.mock('react-router-dom-v5-compat', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../components/UserAvatar', () => ({
  UserAvatar: ({ enableReconnect }: { enableReconnect: boolean }) => (
    <span data-testid="user-avatar">{enableReconnect ? 'reconnect' : 'no-reconnect'}</span>
  ),
}));

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  sessionStorage.clear();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <FunctionCreatePage />
    </MemoryRouter>,
  );

const fillForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
  await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
  await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
  await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');
};

describe('FunctionCreatePage', () => {
  it('renders CreateFunctionForm', () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');

    renderPage();

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('calls generateFunction, creates repo with secrets, then navigates on submit', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser' }));
    const user = userEvent.setup();
    const files = [{ path: 'func.yaml', mode: '100644', content: 'name: f', type: 'blob' }];
    mockGenerateFunction.mockResolvedValue(files);
    mockGenerateKubeconfig.mockResolvedValue('kubeconfig-json');
    mockCreateRepoWithSecret.mockResolvedValue(undefined);

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockGenerateFunction).toHaveBeenCalledWith({
        name: 'my-func',
        runtime: 'node',
        registry: 'image-registry.openshift-image-registry.svc:5000/',
        namespace: 'default',
        branch: 'main',
      });
    });

    await waitFor(() => {
      expect(mockGenerateKubeconfig).toHaveBeenCalledWith('default');
    });

    await waitFor(() => {
      expect(mockCreateRepoWithSecret).toHaveBeenCalledWith(
        { owner: 'testuser', name: 'my-repo', url: '', defaultBranch: 'main' },
        files,
        'Initialize Knative function project',
        { name: 'KUBECONFIG', value: 'kubeconfig-json' },
      );
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });
  });

  it('shows an alert on error', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser' }));
    const user = userEvent.setup();
    mockGenerateFunction.mockRejectedValue(new Error('Backend error'));

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(screen.getByText('Backend error')).toBeInTheDocument();
    });
  });

  it('renders UserAvatar in header', () => {
    renderPage();

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('shows warning and hides form when no PAT is set', () => {
    renderPage();

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument();
  });
});
