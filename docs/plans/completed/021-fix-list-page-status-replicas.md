# Fix List Page Status and Replicas Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Show correct status, URL, and replicas for Knative-deployed functions on the list page by watching both Knative Services and Deployments per function.

**Architecture:** `useClusterService` accepts function names and makes two `useK8sWatchResource` calls (Knative Services + Deployments) scoped via `In` label selector. When no names are known, pass `null` to skip the watch. `useFunctionListPage` derives function names from loaded repos and passes them to `useClusterService`. The merge logic uses the Knative Service for status and URL, and the Deployment for replicas.

**Tech Stack:** OCP Dynamic Plugin SDK (`useK8sWatchResource`, `Operator.In`), React, TypeScript, Vitest

---

### Task 1: Update useClusterService to accept function names and watch Knative Services

**Files:**
- Modify: `src/services/cluster/useClusterService.ts`
- Test: `src/services/cluster/useClusterService.test.tsx`

**Step 1: Write failing test for Knative Service watch**

Add a test that verifies `useClusterService(['my-func'])` calls `useK8sWatchResource` with the Knative Service GVK and `In` selector, and returns the result as `knativeServices`.

```tsx
// In useClusterService.test.tsx, add this test:

it('watches Knative Services with In selector for given function names', () => {
  const mockKsvc = {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: 'my-func',
      namespace: 'demo',
      labels: { 'function.knative.dev/name': 'my-func' },
    },
    status: {
      url: 'https://my-func-demo.apps.example.com',
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };

  mockUseK8sWatchResource
    .mockReturnValueOnce([[mockKsvc], true, null])   // Knative Services
    .mockReturnValueOnce([[], true, null]);           // Deployments

  render(<TestConsumer functionNames={['my-func']} />);

  expect(mockUseK8sWatchResource).toHaveBeenCalledWith({
    groupVersionKind: { group: 'serving.knative.dev', version: 'v1', kind: 'Service' },
    isList: true,
    selector: {
      matchExpressions: [
        { key: 'function.knative.dev/name', operator: 'In', values: ['my-func'] },
      ],
    },
  });
  expect(screen.getByTestId('ksvc-count')).toHaveTextContent('1');
});
```

The `TestConsumer` must be updated to accept `functionNames` and pass it to `useClusterService`, and render `ksvc-count`.

```tsx
function TestConsumer({ functionNames = [] }: { functionNames?: string[] }) {
  const { knativeServices, deployments, loaded, error } = useClusterService(functionNames);
  return (
    <>
      <span data-testid="loaded">{String(loaded)}</span>
      <span data-testid="error">{String(error)}</span>
      <span data-testid="ksvc-count">{knativeServices.length}</span>
      <span data-testid="dep-count">{deployments.length}</span>
      {deployments.map((d) => (
        <span key={d.metadata?.name} data-testid="deployment">
          {d.metadata?.name}
        </span>
      ))}
    </>
  );
}
```

**Step 2: Run test to verify it fails**

Run: `yarn test src/services/cluster/useClusterService.test.tsx`
Expected: FAIL (useClusterService does not accept args, no knativeServices property)

**Step 3: Implement the changes in useClusterService**

```ts
import {
  K8sResourceKind,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import { OcpClusterService } from './OcpClusterService';

const instance = new OcpClusterService();

const FUNCTION_NAME_LABEL = 'function.knative.dev/name';

interface ClusterService {
  knativeServices: K8sResourceKind[];
  deployments: K8sResourceKind[];
  loaded: boolean;
  error: unknown;
  generateKubeconfig: (namespace: string) => Promise<string>;
}

export function useClusterService(functionNames: string[] = []): ClusterService {
  const knSvcConfig = useMemo(
    () =>
      functionNames.length > 0
        ? {
            groupVersionKind: { group: 'serving.knative.dev', version: 'v1', kind: 'Service' },
            isList: true,
            selector: {
              matchExpressions: [
                { key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames },
              ],
            },
          }
        : null,
    [functionNames],
  );

  const depConfig = useMemo(
    () =>
      functionNames.length > 0
        ? {
            groupVersionKind: { group: 'apps', version: 'v1', kind: 'Deployment' },
            isList: true,
            selector: {
              matchExpressions: [
                { key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames },
              ],
            },
          }
        : null,
    [functionNames],
  );

  const [knSvcs, knLoaded, knError] = useK8sWatchResource<K8sResourceKind[]>(knSvcConfig);
  const [deps, depLoaded, depError] = useK8sWatchResource<K8sResourceKind[]>(depConfig);

  return {
    knativeServices: knLoaded ? (knSvcs ?? []) : [],
    deployments: depLoaded ? (deps ?? []) : [],
    loaded: knLoaded && depLoaded,
    error: knError || depError,
    generateKubeconfig: instance.generateKubeconfig.bind(instance),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `yarn test src/services/cluster/useClusterService.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/cluster/useClusterService.ts src/services/cluster/useClusterService.test.tsx
git commit -m "feat: useClusterService watches Knative Services and Deployments by name"
```

---

### Task 2: Update existing useClusterService tests

**Files:**
- Modify: `src/services/cluster/useClusterService.test.tsx`

**Step 1: Update existing tests for new API**

The existing tests need to be updated:
1. `TestConsumer` already updated in Task 1.
2. The "returns raw deployments when loaded" test needs to mock two `useK8sWatchResource` calls (Knative Services + Deployments) since the hook now makes two calls.
3. Remove `useActiveNamespace` mock and the two namespace-related tests (no longer used).
4. Add test for `null` config when `functionNames` is empty.

Update the existing test:

```tsx
it('returns deployments when loaded', () => {
  mockUseK8sWatchResource
    .mockReturnValueOnce([[], true, null])                  // Knative Services
    .mockReturnValueOnce([[mockDeployment], true, null]);    // Deployments

  render(<TestConsumer functionNames={['func-demo-26']} />);

  expect(screen.getByTestId('loaded')).toHaveTextContent('true');
  expect(screen.getByTestId('error')).toHaveTextContent('null');
  expect(screen.getByTestId('dep-count')).toHaveTextContent('1');
  expect(screen.getByTestId('deployment')).toHaveTextContent('func-demo-26');
});
```

Add test for empty function names:

```tsx
it('passes null config when function names are empty', () => {
  mockUseK8sWatchResource.mockReturnValue([[], true, null]);

  render(<TestConsumer />);

  expect(mockUseK8sWatchResource).toHaveBeenCalledWith(null);
  expect(screen.getByTestId('loaded')).toHaveTextContent('true');
  expect(screen.getByTestId('ksvc-count')).toHaveTextContent('0');
  expect(screen.getByTestId('dep-count')).toHaveTextContent('0');
});
```

Add test for not loaded state:

```tsx
it('returns empty arrays when not loaded', () => {
  mockUseK8sWatchResource
    .mockReturnValueOnce([[], false, null])    // Knative Services not loaded
    .mockReturnValueOnce([[], false, null]);   // Deployments not loaded

  render(<TestConsumer functionNames={['my-func']} />);

  expect(screen.getByTestId('loaded')).toHaveTextContent('false');
  expect(screen.getByTestId('ksvc-count')).toHaveTextContent('0');
  expect(screen.getByTestId('dep-count')).toHaveTextContent('0');
});
```

**Step 2: Run tests to verify they pass**

Run: `yarn test src/services/cluster/useClusterService.test.tsx`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/cluster/useClusterService.test.tsx
git commit -m "test: update useClusterService tests for dual watch API"
```

---

### Task 3: Update useFunctionListPage to pass function names and merge both resource types

**Files:**
- Modify: `src/views/FunctionsListPage.tsx`
- Test: `src/views/FunctionsListPage.test.tsx`

**Step 1: Write failing test for status enrichment from Knative Service**

Add a test that verifies a deployed function shows the correct status from the Knative Service. The mock `FunctionTable` needs to render status and replicas (not just names).

Update the `FunctionTable` mock:

```tsx
vi.mock('../components/FunctionTable', () => ({
  FunctionTable: ({ functions }: { functions: { name: string; status: string; replicas: number; url?: string }[] }) =>
    functions.map((f) => (
      <div key={f.name}>
        <span data-testid="fn-name">{f.name}</span>
        <span data-testid="fn-status">{f.status}</span>
        <span data-testid="fn-replicas">{f.replicas}</span>
        <span data-testid="fn-url">{f.url ?? ''}</span>
      </div>
    )),
}));
```

Update the `useClusterService` mock:

```tsx
const mockUseClusterService = vi.fn();
vi.mock('../services/cluster/useClusterService', () => ({
  useClusterService: (...args: unknown[]) => mockUseClusterService(...args),
}));
```

Add the test:

```tsx
it('enriches function with status from Knative Service and replicas from Deployment', async () => {
  renderAuthenticated();
  mockUseSourceControl.mockReturnValue({
    listFunctionRepos: vi.fn().mockResolvedValue([
      {
        owner: 'twoGiants',
        name: 'my-func',
        url: 'https://github.com/twoGiants/my-func',
        defaultBranch: 'main',
      },
    ]),
    fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
  });
  mockUseClusterService.mockReturnValue({
    knativeServices: [
      {
        apiVersion: 'serving.knative.dev/v1',
        kind: 'Service',
        metadata: {
          name: 'my-func',
          namespace: 'demo',
          labels: { 'function.knative.dev/name': 'my-func' },
        },
        status: {
          url: 'https://my-func-demo.apps.example.com',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    ],
    deployments: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'my-func-00001-deployment',
          namespace: 'demo',
          labels: { 'function.knative.dev/name': 'my-func' },
        },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      },
    ],
    loaded: true,
    error: null,
  });

  render(
    <MemoryRouter>
      <FunctionsListPage />
    </MemoryRouter>,
  );

  expect(await screen.findByTestId('fn-status')).toHaveTextContent('Running');
  expect(screen.getByTestId('fn-replicas')).toHaveTextContent('1');
  expect(screen.getByTestId('fn-url')).toHaveTextContent('https://my-func-demo.apps.example.com');
});
```

**Step 2: Run test to verify it fails**

Run: `yarn test src/views/FunctionsListPage.test.tsx`
Expected: FAIL (current code does not use knativeServices, does not pass function names)

**Step 3: Implement changes in useFunctionListPage**

Key changes in `src/views/FunctionsListPage.tsx`:

1. Derive `functionNames` from `functionItems` via `useMemo`.
2. Pass `functionNames` to `useClusterService`.
3. Destructure `knativeServices` alongside `deployments`.
4. Update merge `useMemo` to find both Knative Service and Deployment per item.
5. Update `enrichItem` to accept optional Knative Service and Deployment.
6. Update `deriveStatus` to handle Knative Service conditions.

```tsx
// In useFunctionListPage:

const functionNames = useMemo(
  () => functionItems.map((item) => item.name),
  [functionItems],
);

const { knativeServices, deployments, loaded: clusterLoaded } = useClusterService(functionNames);

const functions = useMemo(
  () =>
    functionItems.map((item) => {
      const ksvc = knativeServices.find(
        (s) => s.metadata?.labels?.['function.knative.dev/name'] === item.name,
      );
      const deployment = deployments.find(
        (d) => d.metadata?.labels?.['function.knative.dev/name'] === item.name,
      );
      return ksvc && deployment ? enrichItem(item, ksvc, deployment) : item;
    }),
  [functionItems, knativeServices, deployments],
);
```

Updated `enrichItem`:

```tsx
function enrichItem(
  item: FunctionTableItem,
  ksvc: K8sResourceKind,
  deployment: K8sResourceKind,
): FunctionTableItem {
  return {
    ...item,
    status: deriveStatus(ksvc, deployment),
    url: ksvc.status?.url,
    replicas: deployment.status?.readyReplicas ?? 0,
    deployment: ksvc,
  };
}
```

Updated `deriveStatus` (both resources required):

```tsx
function deriveStatus(
  ksvc: K8sResourceKind,
  deployment: K8sResourceKind,
): FunctionStatus {
  const conditions = ksvc.status?.conditions ?? [];
  const ready = conditions.find(
    (c: { type: string }) => c.type === 'Ready',
  );
  if (!ready) return 'Deploying';
  if (ready.status === 'True') {
    const desired = deployment.spec?.replicas ?? 0;
    const readyReplicas = deployment.status?.readyReplicas ?? 0;
    if (desired === 0 && readyReplicas === 0) return 'ScaledToZero';
    return 'Running';
  }
  if (ready.status === 'False') return 'Error';
  return 'Deploying';
}
```

**Step 4: Run test to verify it passes**

Run: `yarn test src/views/FunctionsListPage.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/views/FunctionsListPage.tsx src/views/FunctionsListPage.test.tsx
git commit -m "fix: enrich list page with Knative Service status and Deployment replicas"
```

---

### Task 4: Update existing FunctionsListPage tests and add edge cases

**Files:**
- Modify: `src/views/FunctionsListPage.test.tsx`

**Step 1: Update all existing tests for new mock API**

Every `mockUseClusterService` call must now return `{ knativeServices, deployments, loaded, error }` instead of `{ deployments, loaded, error }`. And the mock must accept function names.

For all existing tests that use `mockUseClusterService.mockReturnValue({ deployments: [], loaded: true, error: null })`, change to:

```tsx
mockUseClusterService.mockReturnValue({
  knativeServices: [],
  deployments: [],
  loaded: true,
  error: null,
});
```

For the test "renders table when functions are loaded", update the mock to pass data via `knativeServices` and `deployments` separately.

**Step 2: Add edge case tests**

Add test for ScaledToZero (Knative Service Ready but Deployment has 0 replicas):

```tsx
it('shows ScaledToZero when Knative Service is Ready but Deployment has 0 replicas', async () => {
  renderAuthenticated();
  mockUseSourceControl.mockReturnValue({
    listFunctionRepos: vi.fn().mockResolvedValue([
      {
        owner: 'twoGiants',
        name: 'my-func',
        url: 'https://github.com/twoGiants/my-func',
        defaultBranch: 'main',
      },
    ]),
    fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
  });
  mockUseClusterService.mockReturnValue({
    knativeServices: [
      {
        metadata: { name: 'my-func', namespace: 'demo', labels: { 'function.knative.dev/name': 'my-func' } },
        status: {
          url: 'https://my-func-demo.apps.example.com',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    ],
    deployments: [
      {
        metadata: { name: 'my-func-00001-deployment', namespace: 'demo', labels: { 'function.knative.dev/name': 'my-func' } },
        spec: { replicas: 0 },
        status: { readyReplicas: 0 },
      },
    ],
    loaded: true,
    error: null,
  });

  render(
    <MemoryRouter>
      <FunctionsListPage />
    </MemoryRouter>,
  );

  expect(await screen.findByTestId('fn-status')).toHaveTextContent('ScaledToZero');
  expect(screen.getByTestId('fn-replicas')).toHaveTextContent('0');
});
```

Add test for function names passed to useClusterService:

```tsx
it('passes function names to useClusterService', async () => {
  renderAuthenticated();
  mockUseSourceControl.mockReturnValue({
    listFunctionRepos: vi.fn().mockResolvedValue([
      {
        owner: 'twoGiants',
        name: 'fn-a',
        url: 'https://github.com/twoGiants/fn-a',
        defaultBranch: 'main',
      },
    ]),
    fetchFileContent: vi.fn().mockResolvedValue('name: fn-a\nruntime: go\nnamespace: demo\n'),
  });
  mockUseClusterService.mockReturnValue({
    knativeServices: [],
    deployments: [],
    loaded: true,
    error: null,
  });

  render(
    <MemoryRouter>
      <FunctionsListPage />
    </MemoryRouter>,
  );

  await screen.findByTestId('fn-name');

  expect(mockUseClusterService).toHaveBeenLastCalledWith(['fn-a']);
});
```

**Step 3: Run all tests**

Run: `yarn test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/views/FunctionsListPage.test.tsx
git commit -m "test: update list page tests for dual Knative Service and Deployment enrichment"
```

---

### Task 5: Update FunctionCreatePage mock and run full suite

**Files:**
- Modify: `src/views/FunctionCreatePage.test.tsx`

**Step 1: Update mock to match new API**

The `FunctionCreatePage` only uses `generateKubeconfig` from `useClusterService`. Update the mock to include the new fields:

```tsx
vi.mock('../services/cluster/useClusterService', () => ({
  useClusterService: () => ({
    knativeServices: [],
    deployments: [],
    loaded: true,
    error: null,
    generateKubeconfig: mockGenerateKubeconfig,
  }),
}));
```

**Step 2: Run full test suite**

Run: `yarn test`
Expected: All tests PASS

**Step 3: Run linter**

Run: `yarn lint`
Expected: No errors

**Step 4: Commit**

```bash
git add src/views/FunctionCreatePage.test.tsx
git commit -m "test: update FunctionCreatePage mock for new useClusterService API"
```
