import { describe, test, expect } from 'bun:test';
import { getCountryOsmLevels, getAdminLevelOptions, osmAdminLevels } from './osm-admin-levels';

describe('osm-admin-levels', () => {
  test('osmAdminLevels metadata and defaultLabels are present', () => {
    expect(osmAdminLevels._meta.source).toBeDefined();
    expect(osmAdminLevels.defaultLabels['2']).toBe('Country');
    expect(osmAdminLevels.defaultLabels['4']).toBe('State / Province');
    expect(osmAdminLevels.defaultLabels['6']).toBe('District / County');
    expect(Object.keys(osmAdminLevels.countries).length).toBeGreaterThanOrEqual(190);
  });

  describe('getCountryOsmLevels', () => {
    test('returns country data for Zimbabwe (ZW)', () => {
      const zw = getCountryOsmLevels('ZW');
      expect(zw).not.toBeNull();
      expect(zw?.name).toBe('Zimbabwe');
      expect(zw?.levels['2']).toBe('Country');
      expect(zw?.levels['4']).toBe('Provinces');
      expect(zw?.levels['6']).toBe('Districts');
      expect(zw?.levels['3']).toBeUndefined();
      expect(zw?.levels['5']).toBeUndefined();
    });

    test('supports case-insensitive country codes', () => {
      const zwLower = getCountryOsmLevels('zw');
      expect(zwLower?.name).toBe('Zimbabwe');
    });

    test('returns null for unknown or empty country codes', () => {
      expect(getCountryOsmLevels(undefined)).toBeNull();
      expect(getCountryOsmLevels('')).toBeNull();
      expect(getCountryOsmLevels('ZZ')).toBeNull();
    });
  });

  describe('getAdminLevelOptions', () => {
    test('marks unsupported levels for Zimbabwe as disabled with (Not applicable)', () => {
      const options = getAdminLevelOptions('ZW');
      const lvl3 = options.find((o) => o.value === 3);
      const lvl5 = options.find((o) => o.value === 5);

      expect(lvl3?.disabled).toBe(true);
      expect(lvl3?.isSupportedByCountry).toBe(false);
      expect(lvl3?.disabledReason).toBe('unsupported_by_country');
      expect(lvl3?.label).toContain('(Not applicable)');

      expect(lvl5?.disabled).toBe(true);
      expect(lvl5?.isSupportedByCountry).toBe(false);
      expect(lvl5?.disabledReason).toBe('unsupported_by_country');
      expect(lvl5?.label).toContain('(Not applicable)');
    });

    test('uses country-specific labels for supported levels', () => {
      const options = getAdminLevelOptions('ZW');
      const lvl4 = options.find((o) => o.value === 4);
      const lvl6 = options.find((o) => o.value === 6);

      expect(lvl4?.countryLabel).toBe('Provinces');
      expect(lvl4?.buttonLabel).toBe('Level 4: Provinces');

      expect(lvl6?.countryLabel).toBe('Districts');
      expect(lvl6?.buttonLabel).toBe('Level 6: Districts');
    });

    test('disables level 6 with (Not in data) when not in availableLevels', () => {
      const options = getAdminLevelOptions('ZW', [2, 4]);
      const lvl6 = options.find((o) => o.value === 6);

      expect(lvl6?.disabled).toBe(true);
      expect(lvl6?.disabledReason).toBe('not_in_data');
      expect(lvl6?.label).toContain('(Not in data)');
    });

    test('enables level 6 when present in availableLevels', () => {
      const options = getAdminLevelOptions('ZW', [2, 4, 6]);
      const lvl6 = options.find((o) => o.value === 6);

      expect(lvl6?.disabled).toBe(false);
      expect(lvl6?.disabledReason).toBeUndefined();
      expect(lvl6?.label).toBe('Level 6: Districts');
    });

    test('handles fallback when countryCode is omitted', () => {
      const options = getAdminLevelOptions();
      expect(options.length).toBe(7); // levels 2..8
      const lvl2 = options.find((o) => o.value === 2);
      expect(lvl2?.label).toBe('Level 2: Country');
      expect(lvl2?.disabled).toBe(false);
    });
  });
});
