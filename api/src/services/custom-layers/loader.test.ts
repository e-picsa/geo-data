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

  test('mw_epa contains only EPAs and mw_planning_units contains the full dataset', async () => {
    const epaDef = CUSTOM_LAYERS_REGISTRY.MW.find((d) => d.id === 'mw_epa');
    const allDef = CUSTOM_LAYERS_REGISTRY.MW.find((d) => d.id === 'mw_planning_units');
    expect(epaDef).toBeDefined();
    expect(allDef).toBeDefined();

    const epas = await loadCustomLayer(epaDef!);
    expect(epas.length).toBe(186);
    for (const f of epas) {
      expect(f.properties.name.toUpperCase().endsWith('EPA')).toBe(true);
    }

    const all = await loadCustomLayer(allDef!);
    expect(all.length).toBe(318);
    const types = new Set(all.map((f) => f.properties.unit_type));
    expect([...types].sort()).toEqual(['epa', 'forest_reserve', 'national_park', 'other']);
    // EPA-only layer is a strict subset of the wall-to-wall layer
    const allIds = new Set(all.map((f) => `${f.properties.id}|${f.properties.district}`));
    for (const f of epas) {
      expect(allIds.has(`${f.properties.id}|${f.properties.district}`)).toBe(true);
    }
  });

  test('mw_epa citation states vintage and coverage lists omitted names', async () => {
    const definition = CUSTOM_LAYERS_REGISTRY.MW.find((d) => d.id === 'mw_epa');
    expect(definition).toBeDefined();
    expect(definition!.citation.details).toContain('2013-11-18');
    expect(definition!.coverage).toBeDefined();
    expect(definition!.coverage!.vintage).toContain('2013-11-18');
    expect(definition!.coverage!.featureCount).toBe(186);
    expect(definition!.coverage!.omitted).toContain('Chiluwa');
    expect(definition!.coverage!.omitted).toContain('Likangala');
    expect(definition!.coverage!.omitted).toContain('Makande');

    // Omitted names must match the name-only entries in the registry file
    // and must not duplicate any polygon in the layer.
    const registryFile = Bun.file(
      path.resolve(API_ROOT, 'data/custom-layers/MW/mw_epa_name_registry.json'),
    );
    expect(await registryFile.exists()).toBe(true);
    const registry = await registryFile.json();
    const nameOnly = registry.names
      .filter((n: any) => n.status === 'name-only')
      .map((n: any) => n.name);
    expect([...definition!.coverage!.omitted].sort()).toEqual([...nameOnly].sort());

    const epas = await loadCustomLayer(definition!);
    const polygonNames = new Set(epas.map((f) => f.properties.name.replace(/ EPA$/, '')));
    for (const omitted of definition!.coverage!.omitted) {
      expect(polygonNames.has(omitted)).toBe(false);
    }
  });

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
