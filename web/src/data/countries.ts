import { getData } from 'country-list';

export interface CountryInfo {
  code: string;
  label: string;
  flagUrl: string;
}

export const countries: CountryInfo[] = getData()
  .map((country) => ({
    code: country.code,
    label: country.name,
    flagUrl: `https://flagcdn.com/w20/${country.code.toLowerCase()}.webp`,
  }))
  .sort((a, b) => a.label.localeCompare(b.label));
