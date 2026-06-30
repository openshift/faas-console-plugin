import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditToolbar } from './EditToolbar';

const mockNavigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}));

describe('EditToolbar', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders Back and Save & Deploy buttons', () => {
    render(<EditToolbar hasChanges={false} onSave={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Back to Functions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & Deploy' })).toBeInTheDocument();
  });

  it('disables Save & Deploy when hasChanges is false', () => {
    render(<EditToolbar hasChanges={false} onSave={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Save & Deploy' })).toBeDisabled();
  });

  it('enables Save & Deploy when hasChanges is true', () => {
    render(<EditToolbar hasChanges={true} onSave={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Save & Deploy' })).toBeEnabled();
  });

  it('shows success alert after save and auto-dismisses after 2s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditToolbar hasChanges={true} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Save & Deploy' }));

    expect(screen.getByText('Pushed to GitHub. Deployment running...')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    await waitFor(() => {
      expect(screen.queryByText('Pushed to GitHub. Deployment running...')).not.toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('shows danger alert when save fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('push failed'));
    render(<EditToolbar hasChanges={true} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Save & Deploy' }));

    await waitFor(() => {
      expect(screen.getByText('push failed')).toBeInTheDocument();
    });
  });

  it('navigates to /faas when Back is clicked and no changes', async () => {
    const user = userEvent.setup();
    render(<EditToolbar hasChanges={false} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Back to Functions' }));

    expect(mockNavigate).toHaveBeenCalledWith('/faas');
  });

  it('shows leave modal when Back is clicked with unsaved changes', async () => {
    const user = userEvent.setup();
    render(<EditToolbar hasChanges={true} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Back to Functions' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText('You have unsaved changes. Leave anyway?')).toBeInTheDocument();
  });

  it('closes modal and stays on page when Stay is clicked', async () => {
    const user = userEvent.setup();
    render(<EditToolbar hasChanges={true} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Back to Functions' }));
    await user.click(screen.getByRole('button', { name: 'Stay' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText('You have unsaved changes. Leave anyway?')).not.toBeInTheDocument();
  });

  it('closes modal and navigates when Leave is clicked', async () => {
    const user = userEvent.setup();
    render(<EditToolbar hasChanges={true} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Back to Functions' }));
    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(mockNavigate).toHaveBeenCalledWith('/faas');
  });
});
