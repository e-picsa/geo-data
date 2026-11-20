import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { CUSTOM_LAYERS_REGISTRY } from './registry.ts';
import { loadCustomLayer } from './loader.ts';

const API_ROOT = path.resolve(import.meta.dir, '../../..');

describe('custom layer source files', () => {
  const definitions = Object.values(CUSTOM_LAYERS_REGISTRY).flat();

  test.each(definitions.map((def) => [def.id, def]))(
    '%s exists and loads features',
    async (_id, definition) => {
      const fullPath = path.resolve(API_ROOT, definition.filePath);
      expect(await Bun.file(fullPath).exists()).toBe(true);

      const features = await loadCustomLayer(definition);
      expect(features.length).toBeGreaterThan(0);
      expect(features[0].properties.custom_layer).toBe(definition.id);
    },
  );

  test('mw_epa districts align with OSM admin district names', async () => {
    const definition = CUSTOM_LAYERS_REGISTRY.MW.find((d) => d.id === 'mw_epa');
    expect(definition).toBeDefined();

    // 28 OSM admin_level=4 districts for Malawi — EPA `district` values must
    // match these exactly so the two datasets join cleanly (no case variants,
    // typos, or city-only labels).
    const OSM_MW_DISTRICTS = new Set([
      'Balaka',
      'Blantyre',
      'Chikwawa',
      'Chiradzulu',
      'Chitipa',
      'Dedza',
      'Dowa',
      'Karonga',
      'Kasungu',
      'Likoma',
      'Lilongwe',
      'Machinga',
      'Mangochi',
      'Mchinji',
      'Mulanje',
      'Mwanza',
      'Mzimba',
      'Neno',
      'Nkhata Bay',
      'Nkhotakota',
      'Nsanje',
      'Ntcheu',
      'Ntchisi',
      'Phalombe',
      'Rumphi',
      'Salima',
      'Thyolo',
      'Zomba',
    ]);

    const features = await loadCustomLayer(definition!);
    expect(features.length).toBeGreaterThan(0);
    for (const f of features) {
      expect(OSM_MW_DISTRICTS.has(f.properties.district)).toBe(true);
    }
  });
});
