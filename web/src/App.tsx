import React, { useState, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import * as topojsonClient from 'topojson-client';
import L from 'leaflet';
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


interface BoundaryResponse {
  country_code: string;
  admin_level: number;
  source: string;
  size_kb: number;
  feature_count: number;
  bbox: number[];
  topojson: any;
}

// A helper component to automatically adjust Leaflet bounds
function BoundsFitter({ geoJsonData }: { geoJsonData: any }) {
  const map = useMap();

  useEffect(() => {
    if (geoJsonData) {
      const geoJsonLayer = L.geoJSON(geoJsonData);
      const bounds = geoJsonLayer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20] });
      }
    }
  }, [geoJsonData, map]);

  return null;
}

function App() {
  const [countryCode, setCountryCode] = useState('MW');
  const [adminLevel, setAdminLevel] = useState<number>(2);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BoundaryResponse | null>(null);
  const [geoJsonData, setGeoJsonData] = useState<any>(null);

  const fetchBoundaries = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setGeoJsonData(null);
    
    try {
      const res = await fetch('/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_code: countryCode, admin_level: adminLevel })
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to fetch boundaries');
      }
      
      const payload: BoundaryResponse = await res.json();
      setData(payload);
      
      // Convert TopoJSON to GeoJSON for Leaflet
      if (payload.topojson && payload.topojson.objects) {
        const objectKey = Object.keys(payload.topojson.objects)[0];
        if (objectKey) {
          const geojson = topojsonClient.feature(
            payload.topojson, 
            payload.topojson.objects[objectKey]
          );
          setGeoJsonData(geojson);
        }
      }
      
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const downloadTopojson = () => {
    if (!data?.topojson) return;
    const blob = new Blob([JSON.stringify(data.topojson)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.country_code}_admin_${data.admin_level}.topojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen w-screen flex-col md:flex-row bg-slate-50">
      
      {/* Sidebar Controls */}
      <div className="w-full md:w-80 bg-white border-r border-slate-200 p-6 flex flex-col gap-6 shadow-sm z-10 overflow-y-auto">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Geo Boundaries</h1>
          <p className="text-sm text-slate-500 mt-1">API Testing Interface</p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700">Country Code</label>
            <input 
              type="text" 
              maxLength={2}
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              placeholder="e.g. MW"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700">Admin Level</label>
            <Listbox value={adminLevel} onChange={setAdminLevel}>
              <div className="relative mt-1">
                <ListboxButton className="relative w-full cursor-default rounded-md bg-white py-2 pl-3 pr-10 text-left border border-slate-300 shadow-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm">
                  <span className="block truncate">
                    {adminLevelOptions.find(o => o.value === adminLevel)?.label || `Level ${adminLevel}`}
                  </span>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                    <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
                  </span>
                </ListboxButton>
                <ListboxOptions className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none sm:text-sm">
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
          </div>

          <button
            onClick={fetchBoundaries}
            disabled={loading || !countryCode}
            className="w-full bg-slate-900 text-white font-medium py-2 px-4 rounded-md shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {loading ? 'Generating...' : 'Load Boundaries'}
          </button>
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            {error}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-slate-200">
            <h3 className="font-semibold text-slate-900 text-sm">Results Summary</h3>
            
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-slate-500">Source:</div>
              <div className="font-medium text-right capitalize">{data.source}</div>
              
              <div className="text-slate-500">Features:</div>
              <div className="font-medium text-right">{data.feature_count}</div>
              
              <div className="text-slate-500">Size:</div>
              <div className="font-medium text-right">{data.size_kb} KB</div>
            </div>

            <button
              onClick={downloadTopojson}
              className="mt-2 w-full bg-white border border-slate-300 text-slate-700 font-medium py-2 px-4 rounded-md shadow-sm hover:bg-slate-50 transition-colors"
            >
              Download TopoJSON
            </button>
          </div>
        )}
      </div>

      {/* Map Area */}
      <div className="flex-1 relative z-0">
        <MapContainer 
          center={[0, 0]} 
          zoom={2} 
          scrollWheelZoom={true}
          className="h-full w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {geoJsonData && (
            <>
              {/* Force GeoJSON re-render by using a different key when data changes */}
              <GeoJSON key={JSON.stringify(geoJsonData).slice(0, 100)} data={geoJsonData} style={{ color: '#4f46e5', weight: 2, opacity: 0.8, fillColor: '#818cf8', fillOpacity: 0.2 }} />
              <BoundsFitter geoJsonData={geoJsonData} />
            </>
          )}
        </MapContainer>
        
        {/* Loading overlay for Map */}
        {loading && (
          <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-[400] flex items-center justify-center">
            <div className="bg-white px-6 py-3 rounded-full shadow-lg border border-slate-200 font-medium text-slate-700 flex items-center gap-3">
              <div className="w-4 h-4 border-2 border-slate-600 border-t-transparent rounded-full animate-spin"></div>
              Processing Overpass Data...
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

export default App;
