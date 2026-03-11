import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { GeoJsonObject } from 'geojson';

export interface BoundsFitterProps {
  geoJsonData: GeoJsonObject;
}

export function BoundsFitter({ geoJsonData }: BoundsFitterProps) {
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
