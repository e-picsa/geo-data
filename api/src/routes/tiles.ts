import { corsHeaders } from '../utils/cors.ts';
import { exportTiles } from '../services/map-tiles.ts';

import { z } from 'zod';

const ExportTilesSchema = z.object({
  country_code: z.string().regex(/^[a-zA-Z0-9-_]+$/, 'Invalid country_code format'),
  minZoom: z.number().optional().default(0),
  maxZoom: z.number().max(8, 'Max zoom level restricted to 8').optional().default(8),
});

export const handleTileRoutes = async (req: Request, pathname: string): Promise<Response> => {
  if (req.method === 'POST' && pathname === '/export-tiles') {
    try {
      const body = await req.json();
      const parseResult = ExportTilesSchema.safeParse(body);

      if (!parseResult.success) {
        return new Response(
          JSON.stringify({
            error:
              parseResult.error.issues.map((issue) => issue.message).join(', ') ??
              'Invalid request data',
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const { country_code, minZoom, maxZoom } = parseResult.data;

      const archiveStream = await exportTiles({ country_code, minZoom, maxZoom }, req.signal);

      return new Response(archiveStream, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${country_code}-tiles.tar.gz"`,
        },
      });
    } catch (err: unknown) {
      console.error('Error generating tiles archive:', err);
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
};
