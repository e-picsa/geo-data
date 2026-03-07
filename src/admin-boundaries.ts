import { corsHeaders } from "./utils/cors.ts";
import osmtogeojson from "osmtogeojson";
import mapshaper from "mapshaper";

import { ErrorResponse, JSONResponse } from "./utils/response.ts";
import { validateBody } from "./utils/validation.ts";
import { fetchWithRetry } from "./utils/fetch.ts";
import { getFromCache, saveToCache } from "./utils/google-storage.ts";
import { BOUNDARY_REQUEST_SCHEMA, BoundaryRequestParams } from "./schema.ts";
import { OVERPASS_QUERY_MAPPING } from "./overpass-mapping.ts";

/**
 * Bust cache if query or processing methods change.
 * GCS cache object lifecycle automatically deletes after 90 days
 */
const CACHE_VERSION = 1;

type Source = "cache" | "overpass";

type CachePaths = {
  prefix: string;
  overpass: string;
  geojson: string;
  topojson: string;
};

type TopojsonSummary = {
  size_kb: number;
  feature_count: number;
  bbox: unknown[];
};

export const adminBoundaries = async (req: Request) => {
  try {
    const params = await validateBody(req, BOUNDARY_REQUEST_SCHEMA);
    const { country_code, admin_level } = params;

    const bucket = getCacheBucket();
    const paths = buildCachePaths(country_code, admin_level);

    const cachedTopojson = await readCache<any>(bucket, paths.topojson);
    if (cachedTopojson) {
      console.log(
        `TopoJSON cache hit for ${country_code} admin level ${admin_level}.`,
      );
      return buildSuccessResponse(params, "cache", cachedTopojson);
    }

    const overpassQuery = buildOverpassQuery(country_code, admin_level);

    let osmData = await readCache<any>(bucket, paths.overpass);
    let source: Source = "cache";

    if (osmData) {
      console.log(
        `Overpass cache hit for ${country_code} admin level ${admin_level}.`,
      );
    } else {
      source = "overpass";
      osmData = await fetchOverpassData(req, overpassQuery, country_code);
      writeCache(bucket, paths.overpass, osmData);
    }

    const topojson = await convertOsmToTopojson(
      osmData,
      admin_level,
      bucket,
      paths,
    );

    writeCache(bucket, paths.topojson, topojson);

    return buildSuccessResponse(params, source, topojson);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    console.error(typeof error, error);

    const e = error as any;
    const msg = typeof e === "string"
      ? e
      : e?.details || e?.error || e?.message || e?.msg ||
        "Failed to generate admin boundaries";

    return ErrorResponse(msg);
  }
};

function buildOverpassQuery(countryCode: string, adminLevel: number): string {
  return OVERPASS_QUERY_MAPPING[adminLevel](countryCode).trim();
}

function buildCachePaths(
  countryCode: string,
  adminLevel: number,
): CachePaths {
  const prefix =
    `overpass/v${CACHE_VERSION}/country=${countryCode}/admin_level=${adminLevel}`;

  return {
    prefix,
    overpass: `${prefix}/overpass.json`,
    geojson: `${prefix}/geojson.json`,
    topojson: `${prefix}/topojson.json`,
  };
}

function getCacheBucket(): string | null {
  const bucket = Deno.env.get("OVERPASS_CACHE_BUCKET");
  return bucket && bucket.trim().length > 0 ? bucket : null;
}

async function readCache<T>(
  bucket: string | null,
  key: string,
): Promise<T | null> {
  if (!bucket) return null;
  return await getFromCache(bucket, key);
}

function writeCache(
  bucket: string | null,
  key: string,
  value: unknown,
): void {
  if (!bucket) return;

  saveToCache(bucket, key, value).catch((err) => {
    console.error(`Non-fatal error saving cache key "${key}":`, err);
  });
}

async function fetchOverpassData(
  req: Request,
  overpassQuery: string,
  countryCode: string,
): Promise<unknown> {
  console.log(`Fetching Overpass data for ${countryCode}...`);

  const overpassResponse = await fetchWithRetry(
    "https://overpass-api.de/api/interpreter",
    {
      method: "POST",
      body: overpassQuery,
      signal: req.signal,
    },
  );

  if (!overpassResponse.ok) {
    const errorText = await overpassResponse.text();
    console.error(
      `Overpass API error (${overpassResponse.status}):`,
      errorText,
    );

    let status = 502;
    let message = "Failed to fetch from Overpass API";

    if (overpassResponse.status === 429) {
      status = 429;
      message = "Overpass API rate limit exceeded. Please try again later.";
    } else if (overpassResponse.status === 504) {
      status = 504;
      message =
        "Overpass API gateway timeout. The query took too long to execute.";
    }

    throw new Response(
      JSON.stringify({
        error: message,
        details: errorText || overpassResponse.statusText,
        upstream_status: overpassResponse.status,
      }),
      {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  let osmData: any;
  try {
    osmData = await overpassResponse.json();
  } catch {
    throw new Response(
      JSON.stringify({
        error: "Invalid JSON returned by Overpass API",
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  console.log(
    `Received ${
      osmData?.elements?.length || 0
    } elements from Overpass for ${countryCode}`,
  );

  return osmData;
}

function hasAdminLevel(feature: any, level: number): boolean {
  return Number(feature?.properties?.admin_level) === level;
}

function buildMapshaperInputsAndCommands(
  geojson: any,
  adminLevel: number,
): {
  input: Record<string, unknown>;
  commands: string[];
} {
  const input: Record<string, unknown> = {
    "input.geojson": geojson,
  };

  const commands: string[] = [
    `-i input.geojson`,
    `-clean`,
    `-simplify weighting=0.5 10%`,
    `-filter-islands min-area=10km2`,
    `-each 'this.properties = { id: this.properties["@id"] || this.id, name: this.properties.name || "" }'`,
    `-o output.topojson format=topojson quantization=1e3 bbox`,
  ];

  if (adminLevel === 5) {
    const countryFeatures = geojson.features.filter((f: any) =>
      hasAdminLevel(f, 2)
    );
    const targetFeatures = geojson.features.filter((f: any) =>
      hasAdminLevel(f, 5)
    );

    input["input.geojson"] = {
      type: "FeatureCollection",
      features: targetFeatures,
    };

    input["mask.geojson"] = {
      type: "FeatureCollection",
      features: countryFeatures,
    };

    commands.push(`-clip mask.geojson`);
  }

  return { input, commands };
}

async function convertOsmToTopojson(
  osmData: unknown,
  adminLevel: number,
  bucket: string | null,
  paths: CachePaths,
): Promise<any> {
  console.log("Converting to GeoJSON...");
  let geojson: any = osmtogeojson(osmData as any);

  // Optional/debug cache
  writeCache(bucket, paths.geojson, geojson);

  console.log("Optimizing with Mapshaper...");

  const { input, commands } = buildMapshaperInputsAndCommands(
    geojson,
    adminLevel,
  );

  const topojsonString = await new Promise<string>((resolve, reject) => {
    mapshaper.applyCommands(
      commands.join(" "),
      input,
      (err: Error | null, output: any) => {
        geojson = null as any;

        if (err) {
          reject(err);
          return;
        }

        try {
          resolve(output["output.topojson"].toString());
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });

  console.log("Mapshaper processing complete.");
  return JSON.parse(topojsonString);
}

function summarizeTopojson(topojson: any): TopojsonSummary {
  const topojsonString = JSON.stringify(topojson);
  const bytes = new TextEncoder().encode(topojsonString).length;
  const size_kb = Math.round(bytes / 1024);

  const feature_count = Object.values(topojson.objects || {}).reduce(
    (sum: number, obj: any) => {
      if (Array.isArray(obj?.geometries)) {
        return sum + obj.geometries.length;
      }
      if (obj?.type) {
        return sum + 1;
      }
      return sum;
    },
    0,
  );

  const bbox = Array.isArray(topojson.bbox) ? topojson.bbox : [];

  return {
    size_kb,
    feature_count,
    bbox,
  };
}

function buildSuccessResponse(
  params: BoundaryRequestParams,
  source: Source,
  topojson: any,
): Response {
  const { size_kb, feature_count, bbox } = summarizeTopojson(topojson);

  return JSONResponse(
    {
      country_code: params.country_code,
      admin_level: params.admin_level,
      source,
      size_kb,
      feature_count,
      bbox,
      topojson,
    },
    200,
  );
}
