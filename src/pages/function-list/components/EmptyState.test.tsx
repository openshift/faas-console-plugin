import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { FunctionsEmptyState } from './EmptyState';

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

describe('FunctionsEmptyState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a heading with "No functions found"', () => {
    render(
      <MemoryRouter>
        <FunctionsEmptyState />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('renders a "Create function" button that navigates to /faas/create', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FunctionsEmptyState />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Create function' }));

    expect(mockNavigate).toHaveBeenCalledWith('/faas/create');
  });

  it('shows PAT hint and disabled button when isCreateDisabled is true', () => {
    render(
      <MemoryRouter>
        <FunctionsEmptyState isCreateDisabled />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Create a serverless function to get started.'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create function' })).toBeDisabled();
  });

  it('shows standard body text when isCreateDisabled is false', () => {
    render(
      <MemoryRouter>
        <FunctionsEmptyState isCreateDisabled={false} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Create a serverless function to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create function' })).toBeInTheDocument();
  });

  it('renders the setup guide trigger', () => {
    render(
      <MemoryRouter>
        <FunctionsEmptyState />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'View setup guide.' })).toBeInTheDocument();
  });
});
