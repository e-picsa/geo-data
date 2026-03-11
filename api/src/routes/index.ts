import { corsHeaders } from '../utils/cors.ts';
import { handleAdminRoutes } from './admin.ts';
import { handlePublicRoutes } from './public.ts';

export const appRouter = async (req: Request): Promise<Response> => {
  // handle cors pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname.startsWith('/admin')) {
    return handleAdminRoutes(req, pathname);
  }

  return handlePublicRoutes(req, pathname);
};
