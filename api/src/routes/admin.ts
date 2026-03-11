import { corsHeaders } from '../utils/cors.ts';
import { getCache } from '../utils/cache.ts';

export const handleAdminRoutes = async (req: Request, pathname: string): Promise<Response> => {
  // Only enable these routes if we are running in a development environment
  if (process.env.NODE_ENV !== 'development') {
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  if (req.method === 'POST' && pathname === '/admin/clear-cache') {
    try {
      const cache = getCache();
      await cache.clear();
      return new Response(JSON.stringify({ status: 'success', message: 'Cache cleared' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
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
