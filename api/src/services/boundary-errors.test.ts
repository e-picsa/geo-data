import { expect, test } from 'bun:test';
import { adminBoundaries } from './admin-boundaries.ts';
import { BoundaryError, isClientAbort, toBoundaryErrorResponse } from './boundary-errors.ts';

test('toBoundaryErrorResponse - preserves BoundaryError status, code and retryable', async () => {
  const res = toBoundaryErrorResponse(
    new BoundaryError('UPSTREAM_UNAVAILABLE', 'upstream down', 502, true),
  );
  expect(res.status).toBe(502);
  const data = (await res.json()) as any;
  expect(data.code).toBe('UPSTREAM_UNAVAILABLE');
  expect(data.retryable).toBe(true);
  expect(data.error).toBe('upstream down');
});

test('toBoundaryErrorResponse - maps unknown failures to retryable 500', async () => {
  const res = toBoundaryErrorResponse(new Error('something broke'));
  expect(res.status).toBe(500);
  const data = (await res.json()) as any;
  expect(data.code).toBe('GENERATION_FAILED');
  expect(data.retryable).toBe(true);
});

test('toBoundaryErrorResponse - maps client aborts to 499', async () => {
  const controller = new AbortController();
  controller.abort();
  const res = toBoundaryErrorResponse(new Error('Stream aborted'), controller.signal);
  expect(res.status).toBe(499);
  const data = (await res.json()) as any;
  expect(data.code).toBe('CLIENT_DISCONNECTED');
  expect(data.retryable).toBe(true);
});

test('isClientAbort - detects AbortError and pre-aborted signals', () => {
  const abortError = new Error('interrupted');
  abortError.name = 'AbortError';
  expect(isClientAbort(abortError)).toBe(true);
  expect(isClientAbort(new Error('Stream aborted'))).toBe(true);
  expect(isClientAbort(new Error('boom'))).toBe(false);

  const controller = new AbortController();
  expect(isClientAbort(new Error('boom'), controller.signal)).toBe(false);
  controller.abort();
  expect(isClientAbort(new Error('boom'), controller.signal)).toBe(true);
});

test('adminBoundaries - aborted request returns 499 even for unsupported countries', async () => {
  const controller = new AbortController();
  controller.abort();
  const req = new Request('http://localhost/?country_code=ZZ', {
    signal: controller.signal,
  });
  const res = await adminBoundaries(req);
  expect(res.status).toBe(499);
  const data = (await res.json()) as any;
  expect(data.code).toBe('CLIENT_DISCONNECTED');
});

test('adminBoundaries - passes validation rejections through untouched', async () => {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'this is not json',
  });
  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain('Invalid JSON');
  expect(text).not.toContain('[object Response]');
});
