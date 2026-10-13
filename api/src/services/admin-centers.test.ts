import { test, expect } from 'bun:test';
import { adminCenters } from './admin-centers.ts';

test('adminCenters - Fails validation with invalid country code', async () => {
  const req = new Request('http://localhost/centers?country_code=INVALID', {
    method: 'GET',
  });

  const res = await adminCenters(req);
  expect(res.status).toBe(400);
});

test('adminCenters - Rejects unsupported HTTP method', async () => {
  const req = new Request('http://localhost/centers', {
    method: 'DELETE',
  });

  const res = await adminCenters(req);
  expect(res.status).toBe(405);
});

test('adminCenters - Returns JSON centers for ZM admin_5', async () => {
  const req = new Request('http://localhost/centers?country_code=ZM&admin_level=5', {
    method: 'GET',
  });

  const res = await adminCenters(req);
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('application/json');

  const data = (await res.json()) as any;
  expect(data.country_code).toBe('ZM');
  expect(data.admin_level).toBe(5);
  expect(data.count).toBeGreaterThanOrEqual(100);
  expect(Array.isArray(data.centers)).toBe(true);

  const choma = data.centers.find((c: any) => c.name.includes('Choma'));
  expect(choma).toBeDefined();
  expect(choma.admin_level).toBe(5);
  expect(choma.center_source).toBe('admin_centre');
  expect(choma.center[0]).toBeCloseTo(26.97786, 2);
  expect(choma.center[1]).toBeCloseTo(-16.81419, 2);
});

test('adminCenters - Returns GeoJSON Point features for ZW admin_6', async () => {
  const req = new Request('http://localhost/centers?country_code=ZW&admin_level=6&format=geojson', {
    method: 'GET',
  });

  const res = await adminCenters(req);
  expect(res.status).toBe(200);

  const fc = (await res.json()) as any;
  expect(fc.type).toBe('FeatureCollection');
  expect(Array.isArray(fc.features)).toBe(true);
  expect(fc.features.length).toBeGreaterThanOrEqual(55);

  const harare = fc.features.find((f: any) => f.properties.name === 'Harare');
  expect(harare).toBeDefined();
  expect(harare.geometry.type).toBe('Point');
  expect(harare.properties.center_source).toBe('admin_centre');
  expect(harare.geometry.coordinates[0]).toBeCloseTo(31.04569, 1);
  expect(harare.geometry.coordinates[1]).toBeCloseTo(-17.83177, 1);
});

test('adminCenters - Returns CSV for MW admin_4 via POST', async () => {
  const req = new Request('http://localhost/centers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      country_code: 'MW',
      admin_level: 4,
      format: 'csv',
    }),
  });

  const res = await adminCenters(req);
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('text/csv');

  const csv = await res.text();
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe('id,name,admin_level,longitude,latitude,center_source');
  expect(lines.length).toBeGreaterThanOrEqual(29); // Header + 28 districts

  const likomaLine = lines.find((l) => l.includes('Likoma'));
  expect(likomaLine).toBeDefined();
  expect(likomaLine).toContain(',4,');
  expect(likomaLine).toContain('point_on_surface');
});
