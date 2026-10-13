import { corsHeaders } from '../utils/cors.ts';
import { adminBoundaries } from '../services/admin-boundaries.ts';

export const handlePublicRoutes = async (req: Request, pathname: string): Promise<Response> => {
  const url = new URL(req.url);

  // Health / Readiness Check Endpoint
  if (req.method === 'GET' && pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Root GET: Health check if no country_code, or fetch boundaries if ?country_code=XX is provided
  if (req.method === 'GET' && pathname === '/') {
    if (!url.searchParams.has('country_code')) {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rawTopo = url.searchParams.get('format') === 'topojson';
    return adminBoundaries(req, undefined, rawTopo);
  }

  // Boundaries POST: POST / or POST /boundaries
  if (req.method === 'POST' && (pathname === '/' || pathname === '/boundaries')) {
    return adminBoundaries(req);
  }

  // Boundaries GET: GET /boundaries/:countryCode (e.g. /boundaries/MW, /boundaries/MW.json, /boundaries/MW.topojson)
  const boundariesMatch = pathname.match(
    /^\/boundaries\/([a-zA-Z]{2})(\.topojson|\.topo\.json|\.json)?$/i,
  );
  if (req.method === 'GET' && boundariesMatch) {
    const countryCode = boundariesMatch[1].toUpperCase();
    const ext = boundariesMatch[2]?.toLowerCase();
    const isJson = ext === '.json' || url.searchParams.get('format') === 'json';
    const rawTopo = !isJson;

    return adminBoundaries(req, countryCode, rawTopo);
  }

  // Fallback for unsupported routes
  return new Response('Not Found', {
    status: 404,
    headers: corsHeaders,
  });
};
