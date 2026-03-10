import { corsHeaders } from "./utils/cors.ts";
import { adminBoundaries } from "./admin-boundaries.ts";

const port = parseInt(process.env.PORT ?? "8080");

const VERSION = 20260306;

console.log('Serve api version ' + VERSION);

Bun.serve({
  port,
  async fetch(req: Request) {
    // handle cors pre-flight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    // Health / Readiness Check Endpoint
    if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Main API Endpoint
    if (req.method === "POST" && pathname === "/") {
      return adminBoundaries(req);
    }

    // Fallback for unsupported routes
    return new Response("Not Found", {
      status: 404,
      headers: corsHeaders,
    });
  }
});
