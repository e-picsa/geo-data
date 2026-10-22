import { useMemo } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid';
import type { CustomLayerInfo } from '../data/osm-admin-levels';

export interface CustomLayerSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  customLayers?: CustomLayerInfo[];
  availableCustomLayerIds?: string[];
  disabled?: boolean;
}

export function CustomLayerSelect({
  value,
  onChange,
  customLayers = [],
  availableCustomLayerIds,
  disabled = false,
}: CustomLayerSelectProps) {
  const hasLayers = customLayers.length > 0;

  const options = useMemo(() => {
    const list: Array<{
      value: string | null;
      label: string;
      buttonLabel: string;
      disabled?: boolean;
    }> = [
      {
        value: null,
        label: hasLayers ? 'None (Admin boundaries only)' : 'None available',
        buttonLabel: 'None',
        disabled: false,
      },
    ];

    for (const layer of customLayers) {
      const isAvailable = !availableCustomLayerIds || availableCustomLayerIds.includes(layer.id);
      list.push({
        value: layer.id,
        label: `${layer.name}${isAvailable ? '' : ' (Not in data)'}`,
        buttonLabel: layer.name,
        disabled: !isAvailable,
      });
    }

    return list;
  }, [customLayers, availableCustomLayerIds, hasLayers]);

  const selectedOption = useMemo(() => {
    return options.find((o) => o.value === value) || options[0];
  }, [value, options]);

  const isDisabled = disabled || !hasLayers;

  return (
    <Listbox value={value} onChange={onChange} disabled={isDisabled}>
      <div className="relative mt-1">
        <ListboxButton
          className={`relative w-full cursor-default rounded-md bg-white py-2 pl-3 pr-10 text-left border shadow-sm sm:text-sm focus:outline-none ${
            isDisabled
              ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
              : 'border-slate-300 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500'
          }`}
        >
          <span
            className={`block truncate font-medium ${
              isDisabled
                ? 'text-slate-400'
                : value
                  ? 'text-emerald-900 font-semibold'
                  : 'text-slate-700'
            }`}
          >
            {selectedOption?.buttonLabel || 'None'}
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
            <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
          </span>
        </ListboxButton>

        {!isDisabled && (
          <ListboxOptions className="absolute z-[100] mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none sm:text-sm">
            {options.map((option, idx) => (
              <ListboxOption
                key={option.value ?? `null_${idx}`}
                value={option.value}
                disabled={option.disabled}
                className={({ focus, disabled: optDisabled }) =>
                  `relative select-none py-2 pl-9 pr-3 transition-colors ${
                    optDisabled
                      ? 'cursor-not-allowed text-slate-400 bg-slate-50/70 italic'
                      : focus
                        ? 'cursor-pointer bg-emerald-50 text-emerald-900'
                        : 'cursor-pointer text-slate-900'
                  }`
                }
              >
                {({ selected, disabled: optDisabled }) => (
                  <>
                    <span
                      className={`block truncate ${
                        selected && !optDisabled ? 'font-semibold text-emerald-700' : 'font-normal'
                      } ${optDisabled ? 'text-slate-400' : ''}`}
                    >
                      {option.label}
                    </span>
                    {selected && !optDisabled ? (
                      <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-emerald-700">
                        <CheckIcon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    ) : null}
                  </>
                )}
              </ListboxOption>
            ))}
          </ListboxOptions>
        )}
      </div>
    </Listbox>
  );
}
