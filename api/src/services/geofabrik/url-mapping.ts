export interface CountryConfig {
  geofabrikPath: string | null;
  pbfSizeMb: number;
}

const PBF_SIZE_THRESHOLD_MB = 100;

export const GEOFABRIK_COUNTRIES: Record<string, CountryConfig> = {
  AO: { geofabrikPath: 'africa/angola', pbfSizeMb: 75 },
  BI: { geofabrikPath: 'africa/burundi', pbfSizeMb: 44 },
  BJ: { geofabrikPath: 'africa/benin', pbfSizeMb: 45 },
  BW: { geofabrikPath: 'africa/botswana', pbfSizeMb: 84 },
  BF: { geofabrikPath: 'africa/burkina-faso', pbfSizeMb: 78 },
  CM: { geofabrikPath: 'africa/cameroon', pbfSizeMb: 207 },
  CV: { geofabrikPath: 'africa/cape-verde', pbfSizeMb: 11 },
  CF: { geofabrikPath: 'africa/central-african-republic', pbfSizeMb: 94 },
  TD: { geofabrikPath: 'africa/chad', pbfSizeMb: 89 },
  KM: { geofabrikPath: 'africa/comoros', pbfSizeMb: 12 },
  CG: { geofabrikPath: 'africa/congo-republic-of-the', pbfSizeMb: 45 },
  CD: { geofabrikPath: 'africa/congo-democratic-republic-of-the', pbfSizeMb: 180 },
  DJ: { geofabrikPath: 'africa/djibouti', pbfSizeMb: 13 },
  GQ: { geofabrikPath: 'africa/equatorial-guinea', pbfSizeMb: 16 },
  ER: { geofabrikPath: 'africa/eritrea', pbfSizeMb: 17 },
  ET: { geofabrikPath: 'africa/ethiopia', pbfSizeMb: 104 },
  GA: { geofabrikPath: 'africa/gabon', pbfSizeMb: 38 },
  GM: { geofabrikPath: 'africa/gambia', pbfSizeMb: 14 },
  GH: { geofabrikPath: 'africa/ghana', pbfSizeMb: 95 },
  GN: { geofabrikPath: 'africa/guinea', pbfSizeMb: 82 },
  GW: { geofabrikPath: 'africa/guinea-bissau', pbfSizeMb: 8 },
  CI: { geofabrikPath: 'africa/ivory-coast', pbfSizeMb: 96 },
  KE: { geofabrikPath: 'africa/kenya', pbfSizeMb: 110 },
  LS: { geofabrikPath: 'africa/lesotho', pbfSizeMb: 17 },
  LR: { geofabrikPath: 'africa/liberia', pbfSizeMb: 35 },
  MG: { geofabrikPath: 'africa/madagascar', pbfSizeMb: 76 },
  MW: { geofabrikPath: 'africa/malawi', pbfSizeMb: 55 },
  ML: { geofabrikPath: 'africa/mali', pbfSizeMb: 84 },
  MR: { geofabrikPath: 'africa/mauritania', pbfSizeMb: 59 },
  MU: { geofabrikPath: 'africa/mauritius', pbfSizeMb: 11 },
  MA: { geofabrikPath: 'africa/morocco', pbfSizeMb: 281 },
  MZ: { geofabrikPath: 'africa/mozambique', pbfSizeMb: 102 },
  NA: { geofabrikPath: 'africa/namibia', pbfSizeMb: 105 },
  NE: { geofabrikPath: 'africa/niger', pbfSizeMb: 54 },
  NG: { geofabrikPath: 'africa/nigeria', pbfSizeMb: 639 },
  RW: { geofabrikPath: 'africa/rwanda', pbfSizeMb: 40 },
  ST: { geofabrikPath: 'africa/sao-tome-and-principe', pbfSizeMb: 5 },
  SN: { geofabrikPath: 'africa/senegal', pbfSizeMb: 77 },
  SC: { geofabrikPath: 'africa/seychelles', pbfSizeMb: 4 },
  SL: { geofabrikPath: 'africa/sierra-leone', pbfSizeMb: 33 },
  SO: { geofabrikPath: 'africa/somalia', pbfSizeMb: 49 },
  ZA: { geofabrikPath: 'africa/south-africa', pbfSizeMb: 420 },
  SS: { geofabrikPath: 'africa/south-sudan', pbfSizeMb: 55 },
  SD: { geofabrikPath: 'africa/sudan', pbfSizeMb: 205 },
  SZ: { geofabrikPath: 'africa/swaziland', pbfSizeMb: 14 },
  TZ: { geofabrikPath: 'africa/tanzania', pbfSizeMb: 138 },
  TG: { geofabrikPath: 'africa/togo', pbfSizeMb: 36 },
  UG: { geofabrikPath: 'africa/uganda', pbfSizeMb: 86 },
  ZM: { geofabrikPath: 'africa/zambia', pbfSizeMb: 96 },
  ZW: { geofabrikPath: 'africa/zimbabwe', pbfSizeMb: 83 },

  DE: { geofabrikPath: 'europe/germany', pbfSizeMb: 2100 },
  FR: { geofabrikPath: 'europe/france', pbfSizeMb: 1600 },
  GB: { geofabrikPath: 'europe/great-britain', pbfSizeMb: 750 },
  IT: { geofabrikPath: 'europe/italy', pbfSizeMb: 520 },
  ES: { geofabrikPath: 'europe/spain', pbfSizeMb: 480 },
  PL: { geofabrikPath: 'europe/poland', pbfSizeMb: 520 },
  UA: { geofabrikPath: 'europe/ukraine', pbfSizeMb: 380 },
  RO: { geofabrikPath: 'europe/romania', pbfSizeMb: 260 },
  NL: { geofabrikPath: 'europe/netherlands', pbfSizeMb: 180 },
  BE: { geofabrikPath: 'europe/belgium', pbfSizeMb: 85 },
  GR: { geofabrikPath: 'europe/greece', pbfSizeMb: 120 },
  PT: { geofabrikPath: 'europe/portugal', pbfSizeMb: 110 },
  SE: { geofabrikPath: 'europe/sweden', pbfSizeMb: 280 },
  AT: { geofabrikPath: 'europe/austria', pbfSizeMb: 210 },
  CH: { geofabrikPath: 'europe/switzerland', pbfSizeMb: 95 },
  CZ: { geofabrikPath: 'europe/czech-republic', pbfSizeMb: 180 },
  HU: { geofabrikPath: 'europe/hungary', pbfSizeMb: 110 },
  IE: { geofabrikPath: 'europe/ireland-and-northern-ireland', pbfSizeMb: 75 },
  DK: { geofabrikPath: 'europe/denmark', pbfSizeMb: 65 },
  NO: { geofabrikPath: 'europe/norway', pbfSizeMb: 180 },
  FI: { geofabrikPath: 'europe/finland', pbfSizeMb: 150 },
  SK: { geofabrikPath: 'europe/slovakia', pbfSizeMb: 95 },
  LT: { geofabrikPath: 'europe/lithuania', pbfSizeMb: 55 },
  LV: { geofabrikPath: 'europe/latvia', pbfSizeMb: 45 },
  EE: { geofabrikPath: 'europe/estonia', pbfSizeMb: 35 },
  SI: { geofabrikPath: 'europe/slovenia', pbfSizeMb: 45 },
  HR: { geofabrikPath: 'europe/croatia', pbfSizeMb: 65 },
  BA: { geofabrikPath: 'europe/bosnia-herzegovina', pbfSizeMb: 35 },
  RS: { geofabrikPath: 'europe/serbia', pbfSizeMb: 65 },
  AL: { geofabrikPath: 'europe/albania', pbfSizeMb: 30 },
  MK: { geofabrikPath: 'europe/macedonia', pbfSizeMb: 25 },
  ME: { geofabrikPath: 'europe/montenegro', pbfSizeMb: 18 },
  XK: { geofabrikPath: 'europe/kosovo', pbfSizeMb: 22 },

  US: { geofabrikPath: 'north-america/us', pbfSizeMb: 8500 },
  CA: { geofabrikPath: 'north-america/canada', pbfSizeMb: 1200 },
  MX: { geofabrikPath: 'north-america/mexico', pbfSizeMb: 380 },

  BR: { geofabrikPath: 'south-america/brazil', pbfSizeMb: 1400 },
  AR: { geofabrikPath: 'south-america/argentina', pbfSizeMb: 450 },
  CO: { geofabrikPath: 'south-america/colombia', pbfSizeMb: 280 },
  PE: { geofabrikPath: 'south-america/peru', pbfSizeMb: 220 },
  VE: { geofabrikPath: 'south-america/venezuela', pbfSizeMb: 180 },
  CL: { geofabrikPath: 'south-america/chile', pbfSizeMb: 180 },
  EC: { geofabrikPath: 'south-america/ecuador', pbfSizeMb: 110 },
  BO: { geofabrikPath: 'south-america/bolivia', pbfSizeMb: 110 },
  PY: { geofabrikPath: 'south-america/paraguay', pbfSizeMb: 75 },
  UY: { geofabrikPath: 'south-america/uruguay', pbfSizeMb: 55 },
  GY: { geofabrikPath: 'south-america/guyana', pbfSizeMb: 18 },
  SR: { geofabrikPath: 'south-america/suriname', pbfSizeMb: 16 },
  GF: { geofabrikPath: 'south-america/french-guiana', pbfSizeMb: 8 },

  IN: { geofabrikPath: 'asia/india', pbfSizeMb: 1800 },
  CN: { geofabrikPath: 'asia/china', pbfSizeMb: 3200 },
  JP: { geofabrikPath: 'asia/japan', pbfSizeMb: 1200 },
  ID: { geofabrikPath: 'asia/indonesia', pbfSizeMb: 450 },
  PK: { geofabrikPath: 'asia/pakistan', pbfSizeMb: 280 },
  BD: { geofabrikPath: 'asia/bangladesh', pbfSizeMb: 150 },
  TH: { geofabrikPath: 'asia/thailand', pbfSizeMb: 220 },
  VN: { geofabrikPath: 'asia/vietnam', pbfSizeMb: 220 },
  MY: { geofabrikPath: 'asia/malaysia', pbfSizeMb: 180 },
  PH: { geofabrikPath: 'asia/philippines', pbfSizeMb: 150 },
  KR: { geofabrikPath: 'asia/south-korea', pbfSizeMb: 220 },
  NP: { geofabrikPath: 'asia/nepal', pbfSizeMb: 65 },
  LK: { geofabrikPath: 'asia/sri-lanka', pbfSizeMb: 55 },
  MM: { geofabrikPath: 'asia/myanmar', pbfSizeMb: 110 },
  KH: { geofabrikPath: 'asia/cambodia', pbfSizeMb: 65 },
  LA: { geofabrikPath: 'asia/laos', pbfSizeMb: 45 },
  BT: { geofabrikPath: 'asia/bhutan', pbfSizeMb: 12 },
  MN: { geofabrikPath: 'asia/mongolia', pbfSizeMb: 65 },

  AU: { geofabrikPath: 'australia-oceania/australia', pbfSizeMb: 850 },
  NZ: { geofabrikPath: 'australia-oceania/new-zealand', pbfSizeMb: 120 },
};

export function getCountryConfig(countryCode: string): CountryConfig | null {
  return GEOFABRIK_COUNTRIES[countryCode.toUpperCase()] || null;
}

export function shouldUseGeofabrik(countryCode: string): boolean {
  const config = getCountryConfig(countryCode);
  if (!config || !config.geofabrikPath) return false;
  return config.pbfSizeMb <= PBF_SIZE_THRESHOLD_MB;
}

export function getGeofabrikUrl(countryCode: string): string | null {
  const config = getCountryConfig(countryCode);
  if (!config?.geofabrikPath) return null;
  return `https://download.geofabrik.de/${config.geofabrikPath}-latest.osm.pbf`;
}
