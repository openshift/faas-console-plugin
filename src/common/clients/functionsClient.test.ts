import { waitFor } from '@testing-library/dom';
import { http, HttpResponse } from 'msw';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { timerFake } from '../testing/timerFake';
import { WorkflowRunRecord } from '../types';
import { receiveWorkflowRunEvents } from './functionsClient';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: sdkTestDoubles.consoleFetchFake,
}));

describe('receiveWorkflowRunEvents', () => {
  let close: () => void = () => {};

  afterEach(() => {
    close();
    server.resetHandlers();
  });

  it('delivers parsed build-status events to the data callback', async () => {
    workflowWatchStub({ snapshot: { 'alice/fn': { status: 'Building' } } });

    const data: WorkflowRunRecord[] = [];
    close = receiveWorkflowRunEvents(
      (msg) => data.push(msg),
      () => {},
    );

    await waitFor(() => expect(data).toHaveLength(1));
    expect(data[0]['alice/fn'].status).toBe('Building');
  });

  it('reports auth error and stops on 401 app-error', async () => {
    using timer = timerFake();
    workflowWatchStub({ appError: { message: 'token expired', code: 401 } });

    const errors: string[] = [];
    const data: WorkflowRunRecord[] = [];

    close = receiveWorkflowRunEvents(
      (msg) => data.push(msg),
      (errMsg) => errors.push(errMsg),
    );

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBe('Authentication expired. Reconnect to GitHub and refresh.');

    // If close() wasn't called, the transport would reconnect and deliver more errors.
    workflowWatchStub({ snapshot: { 'a/b': { status: 'Building' } } });

    await timer.advance(5000);
    expect(data).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('passes app-error message through to errorCbk for non-auth errors', async () => {
    workflowWatchStub({ appError: { message: 'rate limited', code: 429 } });

    const errors: string[] = [];
    close = receiveWorkflowRunEvents(
      () => {},
      (msg) => errors.push(msg),
    );

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBe('rate limited');
  });

  it('reports server error with status code on HTTP failure', async () => {
    workflowWatchStub({ errorResponse: { status: 503 } });

    const errors: string[] = [];
    close = receiveWorkflowRunEvents(
      () => {},
      (msg) => errors.push(msg),
    );

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBe('Server error (503)');
  });

  it('reports connection error message on network failure', async () => {
    workflowWatchStub({ networkError: true });

    const errors: string[] = [];
    close = receiveWorkflowRunEvents(
      () => {},
      (msg) => errors.push(msg),
    );

    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/^Connection to the server was lost: .+\. Reconnecting\.\.\.$/);
  });

  function workflowWatchStub({
    snapshot,
    appError,
    errorResponse,
    networkError,
  }: {
    snapshot?: WorkflowRunRecord;
    appError?: { message: string; code?: number };
    errorResponse?: { status: number };
    networkError?: true;
  }): void {
    server.use(
      http.get(`${BACKEND_API}/api/v1/func/build/watch`, () => {
        if (networkError) return HttpResponse.error();
        if (errorResponse) return new HttpResponse(null, { status: errorResponse.status });

        const [type, payload] = appError ? ['app-error', appError] : ['build-status', snapshot];
        return HttpResponse.text(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
  }
});
