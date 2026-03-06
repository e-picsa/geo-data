# Use the official Deno alpine image for a minimal footprint
FROM denoland/deno:alpine-2.1.4

# Cloud run defaults to 8080
EXPOSE 8080

WORKDIR /app

# Prefer not to run as root.
USER deno

# Cache dependencies
COPY import_map.json deno.jsonc ./

# Now we perform the rest of the copy
COPY . .

# Cache the app
RUN deno cache src/main.ts

# Run the index edge function natively
# --allow-net: Run web server and query Overpass API
# --allow-env: Read PORT variable and other configuration
# --allow-read: Mapshaper requires some file IO semantics internally
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "src/main.ts"]
