import fs from 'node:fs/promises';
import path from 'node:path';
import { getCache } from '../utils/cache/cache.utils.ts';
import { corsHeaders } from '../utils/cors.ts';

export const handleAdminRoutes = async (req: Request, pathname: string): Promise<Response> => {
  // Disabled in production — set NODE_ENV=production on deployed services.
  // Enabled locally (NODE_ENV unset or 'development') for the dev-only UI.
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  if (req.method === 'POST' && pathname === '/admin/clear-cache') {
    try {
      const cleared: string[] = [];
      const cache = getCache();
      await cache.clear();
      cleared.push('boundary-cache');
      // Rendered tiles: per-country exports + preview tiles, incl. legacy pre-style cache
      await fs.rm(path.join(process.cwd(), '.cache', 'tiles'), { recursive: true, force: true });
      cleared.push('tile-renders');
      return new Response(
        JSON.stringify({ status: 'success', message: 'Cache cleared', cleared }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      return new Response(JSON.stringify({ status: 'error', message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
};
