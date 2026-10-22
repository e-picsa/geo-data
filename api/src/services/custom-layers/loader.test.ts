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
});
