import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "./utils/cors.ts";
import { adminBoundaries } from "./admin-boundaries.ts";

const port = parseInt(Deno.env.get("PORT") ?? "8080");

const abortController = new AbortController();

const shutdown = () => {
  console.log("Shutting down gracefully...");
  abortController.abort();
};

Deno.addSignalListener("SIGINT", shutdown);
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", shutdown);
}

serve(
  async (req: Request) => {
    // handle cors pre-flight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const { pathname } = new URL(req.url);

    // Health / Readiness Check Endpoint
    if (pathname === "/" || pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method !== "POST" && req.method !== "GET") {
      return new Response("Try sending a POST or GET request instead", {
        status: 400,
      });
    }

    // e.g. /climate/country-boundaries/zw
    const pathParts = pathname.split("/");
    const entryPoint = pathParts[2];

    switch (entryPoint) {
      case "admin-boundaries":
        if (req.method !== "POST") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: corsHeaders,
          });
        }
        return adminBoundaries(req);

      default:
        return new Response(`Invalid endpoint: ${entryPoint}`, {
          status: 501,
          headers: corsHeaders, // Keep CORS headers even on error
        });
    }
  },
  { port, signal: abortController.signal },
);
