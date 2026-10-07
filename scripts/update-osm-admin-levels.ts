import fs from 'node:fs';
import path from 'node:path';
import { getData } from 'country-list';

const manualMap: Record<string, string> = {
  turkey: 'TR',
  türkiye: 'TR',
  'sahrawi arab democratic republic|western sahara': 'EH',
  'western sahara': 'EH',
  'united kingdom': 'GB',
  'united states': 'US',
  'united states of america': 'US',
  russia: 'RU',
  'russian federation': 'RU',
  iran: 'IR',
  syria: 'SY',
  bolivia: 'BO',
  venezuela: 'VE',
  tanzania: 'TZ',
  vietnam: 'VN',
  laos: 'LA',
  'south korea': 'KR',
  'north korea': 'KP',
  taiwan: 'TW',
  'republic of china (taiwan)': 'TW',
  'republic of the congo': 'CG',
  congo: 'CG',
  'democratic republic of the congo': 'CD',
  'dr congo': 'CD',
  'ivory coast': 'CI',
  "côte d'ivoire": 'CI',
  "cote d'ivoire": 'CI',
  'east timor': 'TL',
  'timor-leste': 'TL',
  brunei: 'BN',
  moldova: 'MD',
  macedonia: 'MK',
  'north macedonia': 'MK',
  kosovo: 'XK',
  palestine: 'PS',
  'vatican city': 'VA',
  'holy see': 'VA',
  'czech republic': 'CZ',
  czechia: 'CZ',
  swaziland: 'SZ',
  eswatini: 'SZ',
  burma: 'MM',
  myanmar: 'MM',
  'cape verde': 'CV',
  'cabo verde': 'CV',
  micronesia: 'FM',
  'federated states of micronesia': 'FM',
  'são tomé and príncipe': 'ST',
  'sao tome and principe': 'ST',
  'st. vincent and the grenadines': 'VC',
  'saint vincent and the grenadines': 'VC',
  'st. lucia': 'LC',
  'saint lucia': 'LC',
  'st. kitts and nevis': 'KN',
  'saint kitts and nevis': 'KN',
};

const isoCountries = getData() as Array<{ code: string; name: string }>;
const nameToCode = new Map<string, string>();
for (const c of isoCountries) {
  nameToCode.set(c.name.toLowerCase(), c.code);
  const simple = c.name
    .replace(/\s*\([^)]*\)/g, '')
    .toLowerCase()
    .trim();
  nameToCode.set(simple, c.code);
}

function cleanCell(raw: string | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (/\{\{\s*n\/a/i.test(text)) return null;

  // Handle template wrapper: {{{... | actual content }}}
  const pipeIdx = text.indexOf('|');
  if (text.startsWith('{{{') && pipeIdx !== -1) {
    text = text.substring(pipeIdx + 1);
    if (text.endsWith('}}}')) {
      text = text.substring(0, text.length - 3);
    }
  }

  if (/\{\{\s*n\/a/i.test(text)) return null;
  if (/^n\/a[.\s]/i.test(text.trim())) return null;

  // Remove wikilinks [[Target|Label]] -> Label, [[Target]] -> Target
  text = text.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
  // Remove flags {{Flagicon|...}}
  text = text.replace(/\{\{Flagicon\|[^}]+\}\}/gi, '');
  // Remove templates {{...}}
  text = text.replace(/\{\{[^}]+\}\}/g, ' ');
  // Remove small tag contents and references
  text = text.replace(/<small>.*?<\/small>/gis, '');
  text = text.replace(/<ref>.*?<\/ref>/gis, '');
  text = text.replace(/<[^>]+>/g, ' ');
  // Remove wiki bold / italic
  text = text.replace(/'''?/g, '');
  // Remove comments
  text = text.replace(/<!--.*?-->/gis, '');
  // Remove markdown links [http... Label] -> Label or [http...] -> ''
  text = text.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\]]+\]/g, '');
  text = text.replace(/https?:\/\/\S+/g, '');
  text = text.replace(/&nbsp;/g, ' ');

  // Remove trailing braces or pipes
  text = text.replace(/[|}]+$/g, '');
  text = text.replace(/^[|]+/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  // If starts with "rowspan="
  text = text.replace(/^rowspan="\d+"\s*/i, '');
  text = text.replace(/^colspan="\d+"\s*/i, '');
  text = text.trim();

  // Remove trailing question marks or punctuation
  text = text.replace(/\s*\?+$/g, '');
  text = text.replace(/\s*[.,;:]+$/g, '');
  text = text.trim();

  if (!text || text === '-' || text === '–' || text.toLowerCase() === 'none') {
    return null;
  }

  // If text is overly long, summarize gracefully
  const firstSentence = text.split(/(?<=[.!?])\s+|\n|;/)[0]?.trim();
  if (firstSentence && firstSentence.length > 5 && firstSentence.length < text.length) {
    if (text.length > 80) {
      text = firstSentence;
    }
  }

  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text;
}

async function getWikitext(): Promise<string> {
  const localCandidates = [
    path.resolve(process.cwd(), 'scratch/pasted-table.txt'),
    path.resolve(
      process.env.HOME || '',
      '.t3/userdata/attachments/acd9272a-dd7c-453c-b191-c8a7bf36b8f6-e235888a-57fc-48a9-901d-faff0daa40c4-txt.txt',
    ),
  ];

  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      console.log(`Reading wikitext from local file: ${candidate}`);
      return fs.readFileSync(candidate, 'utf8');
    }
  }

  console.log('Fetching wikitext from OSM Wiki API (Template:Admin_level)...');
  const res = await fetch(
    'https://wiki.openstreetmap.org/w/api.php?action=parse&page=Template:Admin_level&prop=wikitext&format=json',
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch from OSM Wiki: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    parse?: { wikitext?: { '*'?: string } };
  };
  const wikitext = json?.parse?.wikitext?.['*'];
  if (!wikitext) {
    throw new Error('No wikitext found in OSM Wiki API response');
  }
  return wikitext;
}

export async function parseOsmAdminLevels() {
  const content = await getWikitext();
  const rows = content.split('|-');

  const config = {
    _meta: {
      source:
        'https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative#10_admin_level_values_for_specific_countries',
      updatedAt: new Date().toISOString().split('T')[0],
    },
    defaultLabels: {
      '2': 'Country',
      '3': 'Region',
      '4': 'State / Province',
      '5': 'District / Council',
      '6': 'District / County',
      '7': 'Municipality / Sub-district',
      '8': 'Municipality / City / Town',
    },
    countries: {} as Record<string, { name: string; levels: Record<string, string> }>,
  };

  for (const row of rows) {
    const flagMatch = row.match(/\{\{Flagicon\|([^}]+)\}\}/i);
    if (!flagMatch) continue;

    const rawName = flagMatch[1].trim();
    const lower = rawName.toLowerCase();
    let code = manualMap[lower] || nameToCode.get(lower);
    if (!code) {
      for (const [k, v] of nameToCode.entries()) {
        if (k.includes(lower) || lower.includes(k)) {
          code = v;
          break;
        }
      }
    }
    if (!code) continue;

    const cells = row
      .split(/\n\|/)
      .map((c) => c.trim())
      .filter(Boolean);
    const levels: Record<string, string> = {};

    for (let i = 1; i < cells.length && i <= 8; i++) {
      const lvl = i + 2; // i=1 -> 3, i=2 -> 4, ... i=6 -> 8
      const cleaned = cleanCell(cells[i]);
      if (cleaned) {
        levels[String(lvl)] = cleaned;
      }
    }

    levels['2'] = 'Country';

    config.countries[code] = {
      name: rawName,
      levels,
    };
  }

  const jsonStr = JSON.stringify(config, null, 2) + '\n';

  const outputFiles = [
    path.resolve(process.cwd(), 'web/src/data/osm-admin-levels.json'),
    path.resolve(process.cwd(), 'api/src/services/geofabrik/osm-admin-levels.json'),
  ];

  for (const out of outputFiles) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, jsonStr, 'utf8');
    console.log(`Wrote config to ${out}`);
  }

  console.log(`Successfully configured ${Object.keys(config.countries).length} countries.`);
}

if (import.meta.main) {
  parseOsmAdminLevels().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
