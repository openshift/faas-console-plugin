import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupGuide } from './SetupGuide';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('SetupGuide', () => {
  it('renders the guide trigger button', () => {
    render(<SetupGuide />);

    expect(screen.getByRole('button', { name: 'View setup guide.' })).toBeInTheDocument();
  });

  it('does not show the guide content until the button is clicked', () => {
    render(<SetupGuide />);

    expect(screen.queryByText('Connect GitHub')).not.toBeInTheDocument();
  });

  it('opens a modal with the setup steps when the button is clicked', async () => {
    const user = userEvent.setup();
    render(<SetupGuide />);

    await user.click(screen.getByRole('button', { name: 'View setup guide.' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Setup guide')).toBeInTheDocument();
    expect(screen.getByText('Connect GitHub')).toBeInTheDocument();
    expect(screen.getByText('Create a namespace and secret')).toBeInTheDocument();
    expect(screen.getByText('Create a function')).toBeInTheDocument();
    expect(screen.getByText('Edit and redeploy')).toBeInTheDocument();
    expect(screen.getByText('Undeploy a function')).toBeInTheDocument();
  });

  it('closes the modal when Close is clicked', async () => {
    const user = userEvent.setup();
    render(<SetupGuide />);

    await user.click(screen.getByRole('button', { name: 'View setup guide.' }));
    expect(screen.getByText('Connect GitHub')).toBeInTheDocument();

    await user.click(screen.getByText('Close'));

    expect(screen.queryByText('Connect GitHub')).not.toBeInTheDocument();
  });
});
