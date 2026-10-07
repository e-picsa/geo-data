import React, { useMemo } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid';
import { getAdminLevelOptions, AdminLevelOptionInfo } from '../data/osm-admin-levels';

export type AdminLevelOption = AdminLevelOptionInfo;

export interface AdminLevelSelectProps {
  value: number;
  onChange: (value: number) => void;
  countryCode?: string;
  availableLevels?: number[];
  disabled?: boolean;
}

export function AdminLevelSelect({
  value,
  onChange,
  countryCode,
  availableLevels,
  disabled = false,
}: AdminLevelSelectProps) {
  const options = useMemo(() => {
    return getAdminLevelOptions(countryCode, availableLevels);
  }, [countryCode, availableLevels]);

  const selectedOption = options.find((o) => o.value === value);

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className="relative mt-1">
        <ListboxButton className="relative w-full cursor-default rounded-md bg-white py-2 pl-3 pr-10 text-left border border-slate-300 shadow-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm">
          <span className="block truncate font-medium text-slate-900">
            {selectedOption?.buttonLabel || `Level ${value}`}
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
            <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
          </span>
        </ListboxButton>
        <ListboxOptions className="absolute z-[100] mt-1 max-h-64 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none sm:text-sm">
          {options.map((option) => (
            <ListboxOption
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className={({ focus, disabled: optDisabled }) =>
                `relative select-none py-2 pl-9 pr-3 transition-colors ${
                  optDisabled
                    ? 'cursor-not-allowed text-slate-400 bg-slate-50/70 italic'
                    : focus
                      ? 'cursor-pointer bg-indigo-50 text-indigo-900'
                      : 'cursor-pointer text-slate-900'
                }`
              }
            >
              {({ selected, disabled: optDisabled }) => (
                <>
                  <div className="flex items-center justify-between">
                    <span
                      className={`block truncate ${
                        selected && !optDisabled ? 'font-semibold text-indigo-600' : 'font-normal'
                      } ${optDisabled ? 'text-slate-400' : ''}`}
                    >
                      {option.label}
                    </span>
                  </div>
                  {selected && !optDisabled ? (
                    <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-indigo-600">
                      <CheckIcon className="h-4 w-4" aria-hidden="true" />
                    </span>
                  ) : null}
                </>
              )}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
