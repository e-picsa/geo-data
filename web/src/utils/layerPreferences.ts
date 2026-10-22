export interface LayerPreferences {
  visible: boolean;
  color: string;
  fillOpacity: number; // 0.0 to 1.0
  lineOpacity: number; // 0.0 to 1.0
  showLabels: boolean;
}

const STORAGE_KEY_PREFIX = 'geo_layer_prefs_';

export const DEFAULT_ADMIN_LAYER_COLOR = '#4f46e5'; // Indigo 600
export const DEFAULT_ADMIN_FILL_OPACITY = 0.15;
export const DEFAULT_ADMIN_LINE_OPACITY = 1.0;

export const DEFAULT_CUSTOM_LAYER_COLOR = '#059669'; // Emerald 600
export const DEFAULT_CUSTOM_FILL_OPACITY = 0.2;
export const DEFAULT_CUSTOM_LINE_OPACITY = 1.0;

/** Curated shortlist of high-contrast colors for map layer discrimination */
export const SHORTLIST_COLORS = [
  '#4f46e5', // Indigo
  '#059669', // Emerald
  '#d97706', // Amber
  '#e11d48', // Rose
  '#7c3aed', // Purple
  '#0891b2', // Cyan
  '#475569', // Slate
];

export function getLayerPreferences(
  layerId: string,
  defaultColor = DEFAULT_CUSTOM_LAYER_COLOR,
  defaultFillOpacity = DEFAULT_CUSTOM_FILL_OPACITY,
  defaultLineOpacity = DEFAULT_CUSTOM_LINE_OPACITY,
  defaultVisible = true,
): LayerPreferences {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${layerId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      const parsedFillOpacity =
        typeof parsed.fillOpacity === 'number' && !Number.isNaN(parsed.fillOpacity)
          ? Math.max(0, Math.min(1, parsed.fillOpacity))
          : defaultFillOpacity;

      const parsedLineOpacity =
        typeof parsed.lineOpacity === 'number' && !Number.isNaN(parsed.lineOpacity)
          ? Math.max(0, Math.min(1, parsed.lineOpacity))
          : defaultLineOpacity;

      return {
        visible: typeof parsed.visible === 'boolean' ? parsed.visible : defaultVisible,
        color:
          typeof parsed.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.color)
            ? parsed.color
            : defaultColor,
        fillOpacity: parsedFillOpacity,
        lineOpacity: parsedLineOpacity,
        showLabels: Boolean(parsed.showLabels),
      };
    }
  } catch (e) {
    console.warn('Failed to read layer preferences from localStorage', e);
  }
  return {
    visible: defaultVisible,
    color: defaultColor,
    fillOpacity: defaultFillOpacity,
    lineOpacity: defaultLineOpacity,
    showLabels: false,
  };
}

export function saveLayerPreferences(layerId: string, prefs: LayerPreferences): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${layerId}`, JSON.stringify(prefs));
  } catch (e) {
    console.warn('Failed to save layer preferences to localStorage', e);
  }
}
