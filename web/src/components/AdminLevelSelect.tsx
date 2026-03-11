import React from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid';

const adminLevelOptions = [
  { value: 2, label: 'Level 2 (Country)' },
  { value: 3, label: 'Level 3 (Region)' },
  { value: 4, label: 'Level 4 (State/Province)' },
  { value: 5, label: 'Level 5 (District/Council)' },
  { value: 6, label: 'Level 6 (County/Municipality)' },
  { value: 8, label: 'Level 8 (City/Town/Village)' },
];

export interface AdminLevelSelectProps {
  value: number;
  onChange: (value: number) => void;
}

export function AdminLevelSelect({ value, onChange }: AdminLevelSelectProps) {
  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative mt-1">
        <ListboxButton className="relative w-full cursor-default rounded-md bg-white py-2 pl-3 pr-10 text-left border border-slate-300 shadow-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm">
          <span className="block truncate">
            {adminLevelOptions.find(o => o.value === value)?.label || `Level ${value}`}
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
            <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
          </span>
        </ListboxButton>
        <ListboxOptions className="absolute z-[100] mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none sm:text-sm">
          {adminLevelOptions.map((option) => (
            <ListboxOption
              key={option.value}
              className={({ focus }) =>
                `relative cursor-default select-none py-2 pl-10 pr-4 ${
                  focus ? 'bg-indigo-100 text-indigo-900' : 'text-slate-900'
                }`
              }
              value={option.value}
            >
              {({ selected }) => (
                <>
                  <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                    {option.label}
                  </span>
                  {selected ? (
                    <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-indigo-600">
                      <CheckIcon className="h-5 w-5" aria-hidden="true" />
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
