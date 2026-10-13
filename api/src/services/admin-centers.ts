import { z } from 'zod';
import { ErrorResponse, JSONResponse } from '../utils/response.ts';
import { corsHeaders } from '../utils/cors.ts';
import { getBoundariesTopojson } from './admin-boundaries.ts';

export const ADMIN_CENTERS_SCHEMA = z.object({
  country_code: z
    .string()
    .length(2)
    .regex(/^[a-zA-Z]{2}$/, 'Must be a valid 2-letter country code')
    .transform((v: string) => v.toUpperCase()),
  admin_level: z.coerce.number().int().min(1).max(12).optional(),
  format: z.enum(['json', 'geojson', 'csv']).default('json'),
});

export type AdminCentersParams = z.infer<typeof ADMIN_CENTERS_SCHEMA>;

export interface DistrictCenter {
  id: string | number;
  name: string;
  admin_level: number;
  center: [number, number];
  center_source: 'admin_centre' | 'label' | 'point_on_surface' | 'centroid';
}

export const adminCenters = async (req: Request): Promise<Response> => {
  try {
    let rawParams: Record<string, any> = {};

    if (req.method === 'GET') {
      const url = new URL(req.url);
      rawParams = Object.fromEntries(url.searchParams.entries());
    } else if (req.method === 'POST') {
      try {
        rawParams = (await req.json()) as any;
      } catch {
        return ErrorResponse('Invalid JSON body', 400);
      }
    } else {
      return ErrorResponse('Method Not Allowed', 405);
    }

    const parseResult = ADMIN_CENTERS_SCHEMA.safeParse(rawParams);
    if (!parseResult.success) {
      return ErrorResponse(parseResult.error.issues[0]?.message || 'Validation error', 400);
    }

    const { country_code, admin_level, format } = parseResult.data;

    const { topojsonString } = await getBoundariesTopojson(country_code, req.signal);
    const topo = JSON.parse(topojsonString);

    const objectKey = Object.keys(topo.objects)[0];
    const geometries = topo.objects[objectKey]?.geometries || [];

    const centers: DistrictCenter[] = [];

    for (const g of geometries) {
      const props = g.properties || {};
      const level = Number(props.admin_level);

      if (admin_level !== undefined && level !== admin_level) {
        continue;
      }

      if (props.center && Array.isArray(props.center) && props.center.length === 2) {
        centers.push({
          id: props.id ?? g.id,
          name: props.name || '',
          admin_level: level,
          center: props.center,
          center_source: props.center_source || 'centroid',
        });
      }
    }

    // Sort alphabetically by name
    centers.sort((a, b) => a.name.localeCompare(b.name));

    if (format === 'csv') {
      const header = 'id,name,admin_level,longitude,latitude,center_source\r\n';
      const rows = centers
        .map((c) => {
          const escapedName = `"${c.name.replace(/"/g, '""')}"`;
          return `${c.id},${escapedName},${c.admin_level},${c.center[0]},${c.center[1]},${c.center_source}`;
        })
        .join('\r\n');

      return new Response(header + rows, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${country_code}_admin_${admin_level ?? 'all'}_centers.csv"`,
        },
      });
    }

    if (format === 'geojson') {
      const featureCollection = {
        type: 'FeatureCollection',
        features: centers.map((c) => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: c.center,
          },
          properties: {
            id: c.id,
            name: c.name,
            admin_level: c.admin_level,
            center_source: c.center_source,
          },
        })),
      };

      return JSONResponse(featureCollection, 200);
    }

    // Default JSON
    return JSONResponse(
      {
        country_code,
        admin_level: admin_level ?? null,
        count: centers.length,
        centers,
      },
      200,
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('adminCenters error:', error);
    const msg = error instanceof Error ? error.message : 'Internal Server Error';
    return ErrorResponse(msg, 500);
  }
};
