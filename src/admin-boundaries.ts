import { corsHeaders } from "./utils/cors.ts";
import osmtogeojson from "osmtogeojson";
import mapshaper from "mapshaper";
import { z } from "zod";
import { ErrorResponse, JSONResponse } from "./utils/response.ts";
import { validateBody } from "./utils/validation.ts";
import { fetchWithRetry } from "./utils/fetch.ts";
import { getFromCache, saveToCache } from "./utils/gcs.ts";

/**
 * All overpass queries output with processing
 * ```ts
 * out geom qt;           // Outputs way geometry with coordinates
 * ```
 */
const OVERPASS_OUTPUT = `
  out geom qt;
`.trim();

/**
 *
 * Level 2 corresponds to simple national border
 * Levels 3-5 are subnational boundaries and may or may not exist depending on country
 *
 * All subnational queries are optimised to search within bounds of country area
 *
 * TODO
 * - [ ] Typically large memory usage for edge function, will likely need to deploy to cloud-run
 */
const OVERPASS_QUERY_MAPPING: {
  [admin_level: number]: (countryCode: string) => string;
} = {
  // E.g. MW - National Boundary: https://www.openstreetmap.org/relation/195290
  2: (countryCode) => `
      [out:json][timeout:120];
      relation["ISO3166-1"="${countryCode}"]["boundary"="administrative"]["admin_level"="2"];
      ${OVERPASS_OUTPUT}
    `,
  // E.g. MW - Southern Region: https://www.openstreetmap.org/relation/3365670
  3: (countryCode) => `
      [out:json][timeout:120];
      area["ISO3166-1"="${countryCode}"]->.searchArea;
      relation["admin_level"="3"]["boundary"="administrative"]["ISO3166-2"~"^${countryCode}-"](area.searchArea);
      ${OVERPASS_OUTPUT}
    `,
  // E.g. MW - Mangochi District: https://www.openstreetmap.org/relation/7345875
  4: (countryCode) => `
      [out:json][timeout:120];
      area["ISO3166-1"="${countryCode}"]->.searchArea;
      relation["admin_level"="4"]["boundary"="administrative"]["ISO3166-2"~"^${countryCode}-"](area.searchArea);
      ${OVERPASS_OUTPUT}
    `,
  // NOTE - generation admin_level 5 does not include iso data, so just retrieve all level_5 and clip to country boundary when processing
  // (search area checks for any intersection, including shared border regions outside of country)
  // E.g. ZM - Chipata District: https://www.openstreetmap.org/relation/10686740
  5: (countryCode) => `
      [out:json][timeout:120];
      area["ISO3166-1"="${countryCode}"]->.searchArea;
      (
        relation["ISO3166-1"="${countryCode}"]["boundary"="administrative"]["admin_level"="2"];
        relation["admin_level"="5"]["boundary"="administrative"](area.searchArea);
      );
      ${OVERPASS_OUTPUT}
    `,
};
const validAdminLevels = Object.keys(OVERPASS_QUERY_MAPPING).map(Number);

const boundaryRequestSchema = z.object({
  country_code: z
    .string()
    .length(2)
    .regex(/^[a-zA-Z]{2}$/, "Must be a valid 2-letter country code")
    .transform((v: string) => v.toUpperCase()),
  admin_level: z.coerce
    .number()
    .int()
    .refine((v: number) => validAdminLevels.includes(v), {
      message: `Admin level must be one of: ${validAdminLevels.join(", ")}`,
    }),
});

/**
 * Overpass cache version - increment when changing the overpass query
 * Cache auto-deletes entries after 30d
 */
const CACHE_VERSION = 1;

export type AdminBoundariesSchema = z.infer<typeof boundaryRequestSchema>;

export const adminBoundaries = async (req: Request) => {
  try {
    const { admin_level, country_code } = await validateBody(
      req,
      boundaryRequestSchema,
    );

    const overpassQuery =
      OVERPASS_QUERY_MAPPING[admin_level](country_code).trim();

    const cacheBucket = Deno.env.get("OVERPASS_CACHE_BUCKET") || "";
    const cacheKey = `overpass/v${CACHE_VERSION}/country=${country_code}/admin_level=${admin_level}.json`;

    let osmData: any = await getFromCache(cacheBucket, cacheKey);
    let source: "cache" | "overpass" = "cache";

    if (osmData) {
      console.log(
        `Cache hit for ${country_code} admin level ${admin_level}. Skipping Overpass API.`,
      );
    } else {
      source = "overpass";
      console.log(`Fetching Overpass data for ${country_code}...`);

      // Fetch data from Overpass API
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

        let status = 502; // Bad Gateway default
        let message = "Failed to fetch from Overpass API";

        if (overpassResponse.status === 429) {
          status = 429;
          message = "Overpass API rate limit exceeded. Please try again later.";
        } else if (overpassResponse.status === 504) {
          status = 504;
          message =
            "Overpass API gateway timeout. The query took too long to execute.";
        }

        return new Response(
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

      osmData = await overpassResponse.json();
      console.log(
        `Received ${osmData.elements?.length || 0} elements from Overpass for ${country_code}`,
      );

      // Save to cache asynchronously without blocking the response
      saveToCache(cacheBucket, cacheKey, osmData).catch((err) =>
        console.error("Non-fatal error saving to cache:", err),
      );
    }

    // Convert OSM JSON to GeoJSON
    console.log("Converting to GeoJSON...");
    let geojson = osmtogeojson(osmData);

    // Release memory for GC
    osmData = null;

    console.log("Optimizing with Mapshaper...");

    // Mapshaper configuration based on level
    const mapshaperInput: Record<string, any> = { "input.geojson": geojson };

    const mapshaperCmds: string[] = [
      `-i input.geojson`,
      // Fixes OSM gaps/slivers and ensures valid manifold geometry
      `-clean`,
      // Visvalingam simplification at 10% (sufficient for Zoom 8 resolution ~600m/px)
      `-simplify weighting=0.5 10%`,
      // Remove noise/enclaves smaller than 10km2 to reduce payload
      `-filter-islands min-area=10km2`,
      // Drop unnecessary metadata; retain only core identifiers
      `-each 'this.properties = { id: this.properties["@id"] || this.id, name: this.properties.name || "" }'`,
      // Export as TopoJSON with 1e3 quantization for optimized coordinate storage (include bounding box)
      `-o output.topojson format=topojson quantization=1e3 bbox`,
    ];

    // For admin_level 5, we need to clip the target features to the country boundary
    // This is because the target features are not guaranteed to be within the country boundary
    if (admin_level === 5) {
      // Split into level 2 mask and target level
      const countryFeatures = geojson.features.filter(
        (f: any) =>
          f.properties?.admin_level === "2" || f.properties?.admin_level === 2,
      );
      const targetFeatures = geojson.features.filter(
        (f: any) =>
          f.properties?.admin_level === "5" || f.properties?.admin_level === 5,
      );

      // Override the main input with exclusively the target features to prevent duplicate output layers
      mapshaperInput["input.geojson"] = {
        type: "FeatureCollection",
        features: targetFeatures,
      };

      // Pass the national boundary as a secondary clipping mask
      mapshaperInput["mask.geojson"] = {
        type: "FeatureCollection",
        features: countryFeatures,
      };

      // Geometrically slice away exterior geometry using the country layout
      mapshaperCmds.push(`-clip mask.geojson`);
    }

    const topojsonString = await new Promise<string>((resolve, reject) => {
      mapshaper.applyCommands(
        mapshaperCmds.join(" "),
        mapshaperInput,
        (err: Error, output: any) => {
          // release geojson for gc
          geojson = null as any;
          if (err) {
            reject(err);
          } else {
            try {
              resolve(output["output.topojson"].toString());
            } catch (parseError) {
              reject(parseError);
            }
          }
        },
      );
    });

    const topojson = JSON.parse(topojsonString);

    // Get actual bytes
    const bytes = new Blob([topojsonString]).size;

    // Convert to nearest KB
    const size_kb = Math.round(bytes / 1024);

    console.log("Mapshaper processing complete.");

    // Mapshaper usually puts features under the name of the input file, but splits
    // heterogeneous geometries into input1, input2, etc. We sum them up.
    const feature_count = Object.values(topojson.objects).reduce(
      (sum: number, obj: any) => sum + (obj.geometries?.length || 0),
      0,
    );

    // TopoJSON often includes a top-level bbox if requested or generated
    const bbox = topojson.bbox || [];

    return JSONResponse(
      {
        country_code,
        admin_level,
        source,
        size_kb,
        feature_count,
        bbox,
        topojson,
      },
      200,
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error(typeof error, error);
    const e = error as any;
    const msg =
      typeof e === "string"
        ? e
        : e?.details || e?.error || e.message || e.msg || e;
    return ErrorResponse(msg);
  }
};
