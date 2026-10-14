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

test('public routes - GET /boundaries/ZZ returns 404 for unsupported country', async () => {
  const req = new Request('http://localhost/boundaries/ZZ', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/ZZ');
  expect(res.status).toBe(404);
  const data = (await res.json()) as any;
  expect(data.error).toContain('ZZ');
  expect(data.code).toBe('COUNTRY_NOT_SUPPORTED');
  expect(data.retryable).toBe(false);
});

test('public routes - GET /boundaries/XYZ returns 404 for invalid route format', async () => {
  const req = new Request('http://localhost/boundaries/XYZ', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/XYZ');
  expect(res.status).toBe(404); // Route regex only matches 2-letter codes
});

test('public routes - GET /boundaries/MW returns raw compacted TopoJSON with centers omitted by default', async () => {
  const req = new Request('http://localhost/boundaries/MW', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/MW');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');

  const text = await res.text();
  // Validates it is raw TopoJSON (not enveloped in { country_code, topojson })
  const json = JSON.parse(text);
  expect(json.type).toBe('Topology');
  expect(json.objects).toBeDefined();
  expect(json.arcs).toBeDefined();
  expect(json.country_code).toBeUndefined();

  // Arcs are placed at the end: "arcs": [\n ... \n  ]\n}
  expect(text.trim().endsWith('}')).toBe(true);
  expect(text.includes('"arcs": [')).toBe(true);

  // By default, centers are stripped matching web UI default download
  const objKey = Object.keys(json.objects)[0];
  const firstGeom = json.objects[objKey].geometries[0];
  expect(firstGeom.properties.center).toBeUndefined();
  expect(firstGeom.properties.center_source).toBeUndefined();
}, 60000);

test('public routes - GET /boundaries/MW?include_centers=true preserves centers', async () => {
  const req = new Request('http://localhost/boundaries/MW?include_centers=true', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/MW');
  expect(res.status).toBe(200);

  const json = (await res.json()) as any;
  expect(json.type).toBe('Topology');
  const objKey = Object.keys(json.objects)[0];
  const districts = json.objects[objKey].geometries.filter(
    (g: any) => Number(g.properties?.admin_level) === 4,
  );
  expect(districts.length).toBeGreaterThan(0);
  expect(districts[0].properties.center).toBeDefined();
  expect(districts[0].properties.center_source).toBeDefined();
}, 60000);

test('public routes - GET /boundaries/MW.json returns API metadata envelope', async () => {
  const req = new Request('http://localhost/boundaries/MW.json', { method: 'GET' });
  const res = await handlePublicRoutes(req, '/boundaries/MW.json');
  expect(res.status).toBe(200);

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('MW');
  expect(data.size_kb).toBeGreaterThan(0);
  expect(data.feature_count).toBeGreaterThan(0);
  expect(data.topojson).toBeDefined();
}, 60000);
