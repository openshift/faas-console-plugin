import { PROXY_BASE } from '../types';
import { deployFunction } from './functionsClient';

const mockConsoleFetch = vi.fn();

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: (...args: unknown[]) => mockConsoleFetch(...args),
  consoleFetchJSON: vi.fn(),
  isAllNamespacesKey: vi.fn(),
}));

describe('deployFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('POSTs to the deploy endpoint with the branch and SCM token header', async () => {
    sessionStorage.setItem('func-console-pat', 'test-pat');
    mockConsoleFetch.mockResolvedValue(undefined);

    await deployFunction('alice', 'my-func', 'main');

    expect(mockConsoleFetch).toHaveBeenCalledWith(
      `${PROXY_BASE}/api/v1/func/alice/my-func/deploy`,
      {
        method: 'POST',
        headers: { 'X-SCM-Token': 'test-pat', 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main' }),
      },
    );
  });

  it('encodes owner and name in the URL', async () => {
    mockConsoleFetch.mockResolvedValue(undefined);

    await deployFunction('a/b', 'c d', 'main');

    const url = mockConsoleFetch.mock.calls[0][0];
    expect(url).toBe(`${PROXY_BASE}/api/v1/func/a%2Fb/c%20d/deploy`);
  });
});
