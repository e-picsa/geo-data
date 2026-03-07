/**
 * All overpass queries output with processing
 * ```ts
 * out geom qt;           // Outputs way geometry with coordinates
 * ```
 */
const OVERPASS_OUTPUT = `
  out geom qt;
`.trim();

/**
 * Level 2 corresponds to simple national border.
 * Levels 3-5 are subnational boundaries and may or may not exist depending on
 * country.
 *
 * All subnational queries are optimised to search within the bounds of the
 * country area.
 */
export const OVERPASS_QUERY_MAPPING: Record<
  number,
  (countryCode: string) => string
> = {
  // E.g. MW - National Boundary: https://www.openstreetmap.org/relation/195290
  2: (countryCode) => `
      [out:json][timeout:120];
      relation["ISO3166-1"="${countryCode}"]["boundary"="administrative"]["admin_level"="2"];
      ${OVERPASS_OUTPUT}
    `,
  // E.g. MW - Southern Region: https://www.openstreetmap.org/relation/3365670
  3: (countryCode) => `
      [out:json][timeout:120];
      area["ISO3166-1"="${countryCode}"]->.searchArea;
      relation["admin_level"="3"]["boundary"="administrative"]["ISO3166-2"~"^${countryCode}-"](area.searchArea);
      ${OVERPASS_OUTPUT}
    `,
  // E.g. MW - Mangochi District: https://www.openstreetmap.org/relation/7345875
  4: (countryCode) => `
      [out:json][timeout:120];
      area["ISO3166-1"="${countryCode}"]->.searchArea;
      relation["admin_level"="4"]["boundary"="administrative"]["ISO3166-2"~"^${countryCode}-"](area.searchArea);
      ${OVERPASS_OUTPUT}
    `,
  // NOTE - generation admin_level 5 does not include iso data, so just retrieve all level_5 and clip to country boundary when processing
  // (search area checks for any intersection, including shared border regions outside of country)
  // E.g. ZM - Chipata District: https://www.openstreetmap.org/relation/10686740
  5: (countryCode) => `
      [out:json][timeout:120];
      area["ISO3166-1"="${countryCode}"]->.searchArea;
      (
        relation["ISO3166-1"="${countryCode}"]["boundary"="administrative"]["admin_level"="2"];
        relation["admin_level"="5"]["boundary"="administrative"](area.searchArea);
      );
      ${OVERPASS_OUTPUT}
    `,
};
