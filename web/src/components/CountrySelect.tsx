import { useState } from 'react';
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid';
import { countries } from '../data/countries';

export interface CountrySelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function CountrySelect({ value, onChange }: CountrySelectProps) {
  const [query, setQuery] = useState('');

  const selectedCountry = countries.find((c) => c.code === value);

  const filteredCountries =
    query === ''
      ? countries
      : countries.filter((country) => country.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <Combobox
      value={value}
      onChange={(val) => {
        if (val) onChange(val);
      }}
      onClose={() => setQuery('')}
    >
      <div className="relative mt-1">
        <div className="relative w-full cursor-default overflow-hidden rounded-md bg-white text-left border border-slate-300 shadow-sm focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500 sm:text-sm flex">
          {selectedCountry && query === '' && (
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <img
                src={selectedCountry.flagUrl}
                alt={selectedCountry.label}
                className="h-4 w-6 object-cover rounded-sm border border-slate-100"
                loading="lazy"
              />
            </div>
          )}
          <ComboboxInput
            className={`w-full border-none py-2 bg-transparent ${selectedCountry && query === '' ? 'pl-11' : 'pl-3'} pr-10 text-sm leading-5 text-gray-900 focus:ring-0 outline-none`}
            displayValue={(code: string) => countries.find((c) => c.code === code)?.label ?? ''}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Select a Country"
          />
          <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-2">
            <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
          </ComboboxButton>
        </div>

        <ComboboxOptions className="absolute z-[100] mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none sm:text-sm empty:invisible">
          {filteredCountries.length === 0 && query !== '' ? (
            <div className="relative cursor-default select-none px-4 py-2 text-gray-700">
              Nothing found.
            </div>
          ) : (
            filteredCountries.map((country) => (
              <ComboboxOption
                key={country.code}
                className={({ focus }) =>
                  `relative cursor-default select-none py-2 pl-10 pr-4 ${
                    focus ? 'bg-indigo-100 text-indigo-900' : 'text-slate-900'
                  }`
                }
                value={country.code}
              >
                {({ selected }) => (
                  <>
                    <div className="flex items-center gap-2 truncate">
                      <img
                        src={country.flagUrl}
                        alt={country.label}
                        className="h-4 w-6 object-cover rounded-sm border border-slate-100"
                        loading="lazy"
                      />
                      <span
                        className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}
                      >
                        {country.label}
                      </span>
                    </div>
                    {selected ? (
                      <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-indigo-600">
                        <CheckIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    ) : null}
                  </>
                )}
              </ComboboxOption>
            ))
          )}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}
