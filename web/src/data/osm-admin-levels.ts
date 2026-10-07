import osmData from './osm-admin-levels.json';

export interface CountryOsmLevels {
  name: string;
  levels: Record<string, string>;
}

export interface OsmAdminLevelsData {
  _meta: {
    source: string;
    updatedAt: string;
  };
  defaultLabels: Record<string, string>;
  countries: Record<string, CountryOsmLevels>;
}

export const osmAdminLevels = osmData as OsmAdminLevelsData;

export function getCountryOsmLevels(countryCode?: string): CountryOsmLevels | null {
  if (!countryCode) return null;
  return osmAdminLevels.countries[countryCode.toUpperCase()] || null;
}

export interface AdminLevelOptionInfo {
  value: number;
  label: string;
  buttonLabel: string;
  countryLabel?: string;
  defaultLabel: string;
  isSupportedByCountry: boolean;
  disabled: boolean;
  disabledReason?: 'unsupported_by_country' | 'not_in_data';
}

/**
 * Returns options for administrative levels 2 through 8.
 *
 * @param countryCode - 2-letter ISO country code (e.g. "ZW")
 * @param availableLevels - Admin levels actually present in the loaded GeoJSON/TopoJSON dataset
 */
export function getAdminLevelOptions(
  countryCode?: string,
  availableLevels?: number[],
): AdminLevelOptionInfo[] {
  const countryInfo = getCountryOsmLevels(countryCode);
  const levelsToShow = [2, 3, 4, 5, 6, 7, 8];

  return levelsToShow.map((level) => {
    const defaultLabel = osmAdminLevels.defaultLabels[String(level)] || `Level ${level}`;
    const countryLabel = countryInfo?.levels?.[String(level)];
    const isSupportedByCountry = countryInfo ? Boolean(countryLabel) : true;
    const effectiveLabel = countryLabel || defaultLabel;

    let disabled = false;
    let disabledReason: 'unsupported_by_country' | 'not_in_data' | undefined;

    if (!isSupportedByCountry) {
      disabled = true;
      disabledReason = 'unsupported_by_country';
    } else if (availableLevels && availableLevels.length > 0) {
      if (!availableLevels.includes(level)) {
        disabled = true;
        disabledReason = 'not_in_data';
      }
    } else if (level > 6) {
      disabled = true;
      disabledReason = 'not_in_data';
    }

    let displayLabel = `Level ${level}: ${effectiveLabel}`;
    if (disabledReason === 'unsupported_by_country') {
      displayLabel += ' (Not applicable)';
    } else if (disabledReason === 'not_in_data') {
      displayLabel += ' (Not in data)';
    }

    const buttonLabel = `Level ${level}: ${effectiveLabel}`;

    return {
      value: level,
      label: displayLabel,
      buttonLabel,
      countryLabel,
      defaultLabel,
      isSupportedByCountry,
      disabled,
      disabledReason,
    };
  });
}
