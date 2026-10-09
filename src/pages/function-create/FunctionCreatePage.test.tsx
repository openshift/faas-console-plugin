import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import FunctionCreatePage from './FunctionCreatePage';
import { BACKEND_API } from '../../common/testing/constants';
import { startSessionFake, endSessionFake } from '../../common/testing/sessionClientStub';
import { server } from '../../common/testing/mswServer';

const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

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
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
}));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../common/components/UserAvatar', () => ({
  UserAvatar: ({ enableReconnect }: { enableReconnect: boolean }) => (
    <span data-testid="user-avatar">{enableReconnect ? 'reconnect' : 'no-reconnect'}</span>
  ),
}));

function setupCreateFlowHandlers() {
  server.use(
    http.post(`${BACKEND_API}/api/v1/func/create`, () => new HttpResponse(null, { status: 201 })),
  );
}

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
  beforeEach(() => {
    endSessionFake();
    startSessionFake();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    endSessionFake();
  });

  it('renders CreateFunctionForm', () => {
    renderPage();

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('creates function via backend, then navigates on submit', async () => {
    const user = userEvent.setup();
    setupCreateFlowHandlers();

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });
  });

  it('shows an alert on error', async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${BACKEND_API}/api/v1/func/create`, () =>
        HttpResponse.json({ message: 'Backend error' }, { status: 500 }),
      ),
    );

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(screen.getByText(/Backend error/)).toBeInTheDocument();
    });
  });

  it('renders UserAvatar in header', () => {
    endSessionFake();
    renderPage();

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('shows warning and hides form when no PAT is set', () => {
    endSessionFake();
    renderPage();

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument();
  });

  it('sends environment variables to backend during submission', async () => {
    const user = userEvent.setup();
    let capturedRequest: Record<string, unknown> | null = null;
    server.use(
      http.post(`${BACKEND_API}/api/v1/func/create`, async ({ request }) => {
        capturedRequest = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 201 });
      }),
    );

    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    const nameInput = within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0];
    const valueInput = within(envSection).getByRole('textbox', { name: /^Value$/ });

    expect(nameInput).toBeInTheDocument();
    expect(valueInput).toBeInTheDocument();

    await user.type(nameInput, 'MY_VAR');
    await user.type(valueInput, 'my-value');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });

    expect(capturedRequest).toBeTruthy();
    expect(capturedRequest!.envVars).toEqual([
      { name: 'MY_VAR', source: 'value', value: 'my-value', resourceName: '', resourceKey: '' },
    ]);
  });
});
