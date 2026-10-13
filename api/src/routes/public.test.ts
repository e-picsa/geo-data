import { expect, test } from 'bun:test';
import { handlePublicRoutes } from './public.ts';

test('public routes - GET /health returns ok', async () => {
  const req = new Request('http://localhost/health', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/health');
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.status).toBe('ok');
});

test('public routes - GET / without country_code returns health check', async () => {
  const req = new Request('http://localhost/', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/');
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.status).toBe('ok');
});

test('public routes - GET /unknown returns 404', async () => {
  const req = new Request('http://localhost/unknown', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/unknown');
  expect(res.status).toBe(404);
});

test('public routes - GET /boundaries/ZZ returns 400 for unsupported country', async () => {
  const req = new Request('http://localhost/boundaries/ZZ', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/ZZ');
  expect(res.status).toBe(400);
  const data = (await res.json()) as any;
  expect(data.error).toContain('ZZ');
});

test('public routes - GET /boundaries/XYZ returns 404 for invalid route format', async () => {
  const req = new Request('http://localhost/boundaries/XYZ', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/XYZ');
  expect(res.status).toBe(404); // Route regex only matches 2-letter codes
});
