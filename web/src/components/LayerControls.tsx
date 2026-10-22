import { useState } from 'react';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import {
  EyeIcon,
  EyeSlashIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/20/solid';
import { SHORTLIST_COLORS } from '../utils/layerPreferences';

export interface LayerAttributionInfo {
  sourceName: string;
  sourceUrl: string;
  retrievalDate?: string;
  license?: string;
  details: string;
}

export interface LayerControlsProps {
  visible: boolean;
  onToggleVisible: (visible: boolean) => void;
  color: string;
  defaultColor: string;
  onColorChange: (color: string) => void;
  onResetColor: () => void;
  fillOpacity: number;
  onOpacityChange: (opacity: number) => void;
  lineOpacity: number;
  onLineOpacityChange: (opacity: number) => void;
  showLabels: boolean;
  onToggleLabels: (show: boolean) => void;
  attribution: LayerAttributionInfo;
  disabled?: boolean;
}

/**
 * Streamlined layer controls:
 * - Line 1: Visibility toggle, Popover Color & Opacity Picker (Fill & Outline sliders), Color Reset (no label), Labels checkbox ("Labels")
 * - Line 2: Source attribution dropdown with distinct yellow background
 */
export function LayerControls({
  visible,
  onToggleVisible,
  color,
  defaultColor,
  onColorChange,
  onResetColor,
  fillOpacity,
  onOpacityChange,
  lineOpacity,
  onLineOpacityChange,
  showLabels,
  onToggleLabels,
  attribution,
  disabled = false,
}: LayerControlsProps) {
  const [showAttribution, setShowAttribution] = useState<boolean>(false);
  const isCustomColor = color.toLowerCase() !== defaultColor.toLowerCase();

  return (
    <div
      className={`mt-2 space-y-1.5 text-xs transition-opacity ${
        disabled ? 'opacity-50 pointer-events-none' : ''
      }`}
    >
      {/* Line 1: Visibility, Color/Opacity Popover Picker, Reset (no label), Labels Checkbox */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Visibility Toggle */}
          <button
            type="button"
            onClick={() => onToggleVisible(!visible)}
            className={`p-1 rounded transition-colors ${
              visible
                ? 'text-indigo-600 hover:bg-indigo-50'
                : 'text-slate-400 hover:bg-slate-200 hover:text-slate-600'
            }`}
            title={visible ? 'Hide layer' : 'Show layer'}
            aria-label={visible ? 'Hide layer' : 'Show layer'}
          >
            {visible ? <EyeIcon className="w-4 h-4" /> : <EyeSlashIcon className="w-4 h-4" />}
          </button>

          {/* Color & Opacity Popover Picker */}
          <Popover className="relative flex items-center">
            {({ open }) => (
              <>
                <PopoverButton
                  type="button"
                  className={`w-5 h-5 rounded-full border-2 border-white shadow ring-1 ring-slate-300 transition-transform hover:scale-110 focus:outline-none ${
                    open ? 'ring-2 ring-indigo-500 scale-110' : ''
                  }`}
                  style={{ backgroundColor: color }}
                  title="Change color & opacity"
                  aria-label="Change color & opacity"
                />

                <PopoverPanel className="absolute left-0 top-full mt-2 z-50 w-56 rounded-lg bg-white p-3 shadow-xl ring-1 ring-black/10 focus:outline-none text-slate-800 space-y-2.5">
                  <div>
                    <div className="text-[11px] font-semibold text-slate-600 mb-1.5">Colour</div>
                    <div className="flex items-center gap-1.5">
                      {SHORTLIST_COLORS.map((c) => {
                        const isSelected = color.toLowerCase() === c.toLowerCase();
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => onColorChange(c)}
                            className={`w-4 h-4 rounded-full transition-transform ${
                              isSelected
                                ? 'scale-125 ring-2 ring-slate-800 ring-offset-1 z-10'
                                : 'hover:scale-110 opacity-85 hover:opacity-100'
                            }`}
                            style={{ backgroundColor: c }}
                            title={`Select ${c}`}
                            aria-label={`Select ${c}`}
                          />
                        );
                      })}
                      <label
                        className="relative flex items-center cursor-pointer ml-1"
                        title="Custom color picker"
                      >
                        <input
                          type="color"
                          value={color}
                          onChange={(e) => onColorChange(e.target.value)}
                          className="w-4 h-4 rounded-full border border-slate-300 p-0 cursor-pointer overflow-hidden opacity-90 hover:opacity-100"
                          aria-label="Custom color picker"
                        />
                      </label>
                    </div>
                  </div>

                  {/* Fill Opacity Slider within Picker */}
                  <div className="pt-2 border-t border-slate-100 space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-slate-600 font-medium">
                      <span>Fill Opacity</span>
                      <span className="font-mono text-slate-500">
                        {Math.round(fillOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={fillOpacity}
                      onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                      aria-label="Fill opacity slider"
                    />
                  </div>

                  {/* Outline Opacity Slider within Picker */}
                  <div className="pt-2 border-t border-slate-100 space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-slate-600 font-medium">
                      <span>Outline Opacity</span>
                      <span className="font-mono text-slate-500">
                        {Math.round(lineOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={lineOpacity}
                      onChange={(e) => onLineOpacityChange(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                      aria-label="Outline opacity slider"
                    />
                  </div>
                </PopoverPanel>
              </>
            )}
          </Popover>

          {/* Color Reset Button (no label) */}
          {isCustomColor && (
            <button
              type="button"
              onClick={onResetColor}
              title="Reset color"
              aria-label="Reset color"
              className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <ArrowPathIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Labels Checkbox (strictly "Labels") */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-700 flex-shrink-0">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => onToggleLabels(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
          />
          <span className="font-medium text-[11px]">Labels</span>
        </label>
      </div>

      {/* Line 2: Source Attribution Dropdown with Yellow Background */}
      <div className="pt-0.5">
        <button
          type="button"
          onClick={() => setShowAttribution(!showAttribution)}
          className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 transition-colors py-0.5"
          aria-expanded={showAttribution}
        >
          <span>Source Attribution</span>
          <ChevronDownIcon
            className={`w-3.5 h-3.5 transition-transform duration-200 ${
              showAttribution ? 'rotate-180' : ''
            }`}
          />
        </button>

        {showAttribution && (
          <div className="mt-1.5 p-2.5 bg-amber-50/90 border border-amber-200/90 rounded-md text-amber-950 space-y-1.5 shadow-sm">
            <div className="flex items-center justify-between font-semibold">
              <span className="text-[11px] text-amber-900">{attribution.sourceName}</span>
              {attribution.retrievalDate && (
                <span className="text-[10px] text-amber-800 bg-amber-100/90 px-1.5 py-0.5 rounded font-mono">
                  {attribution.retrievalDate}
                </span>
              )}
            </div>

            <p className="text-[11px] text-slate-700 leading-relaxed">{attribution.details}</p>

            {attribution.license && (
              <div className="text-[10px] text-slate-500">
                <span>License: </span>
                <span className="font-semibold text-slate-700">{attribution.license}</span>
              </div>
            )}

            <div className="pt-1 border-t border-amber-200/70 flex items-center justify-between">
              <span className="text-[10px] text-slate-400 font-medium">Link:</span>
              <a
                href={attribution.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-indigo-600 hover:text-indigo-800 underline inline-flex items-center gap-1 font-medium truncate max-w-[190px]"
                title={attribution.sourceName}
              >
                <span>View Source</span>
                <ArrowTopRightOnSquareIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
