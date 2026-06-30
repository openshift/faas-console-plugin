import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { FunctionsEmptyState } from './EmptyState';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

  it('renders a "Create function" link pointing to /faas/create', () => {
    render(
      <MemoryRouter>
        <FunctionsEmptyState />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Create function' });
    expect(link).toHaveAttribute('href', '/faas/create');
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
    const link = screen.getByRole('link', { name: 'Create function' });
    expect(link).toHaveAttribute('href', '/faas/create');
  });
});
