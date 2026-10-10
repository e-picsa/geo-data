# docker build -t epicsa-geo-api .
# docker run --rm -p 8080:8080 epicsa-geo-api

# ---- Build stage ----
FROM oven/bun:1 AS build
WORKDIR /app

# Real Node.js is required: postinstall scripts (sharp, maplibre-gl-native)
# run under `node`, and the tile renderer sidecar executes with it at runtime.
# Debian trixie ships Node 20, which both packages support.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY api/package.json ./api/
COPY web/package.json ./web/

RUN bun install --frozen-lockfile --production --ignore-scripts && \
  MBGL_PKG=$(node -e "console.log(require.resolve('@maplibre/maplibre-gl-native/package.json', { paths: ['/app/api'] }))") && \
  MBGL_DIR=$(dirname "$MBGL_PKG") && \
  cd "$MBGL_DIR" && node "$MBGL_DIR/../../@acalcutt/node-pre-gyp/bin/node-pre-gyp" install --fallback-to-build=false

# ---- Runtime stage ----
# Ubuntu 24.04 matches the @maplibre/maplibre-gl-native prebuilt target
# (libicu74, libcurl4, libpng16-16), which Debian trixie no longer ships.
FROM ubuntu:24.04
WORKDIR /app

# bun (pinned via the same oven image as the build stage), real Node.js 20
# for the tile renderer sidecar, and native libs for maplibre + sharp.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
  apt-get install -y --no-install-recommends nodejs xvfb libcurl4 libicu74 libjpeg8 libpng16-16 libwebp7 libgl1 libopengl0 libuv1t64 && \
  rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/node_modules ./api/node_modules
COPY package.json ./
COPY api/package.json ./api/
COPY api/src ./api/src

# go-pmtiles CLI (static binary): converts the MBTiles staged by
# POST /export-pmtiles into a single-file .pmtiles archive.
ARG PMTILES_VERSION=1.31.2
RUN curl -fsSL -o /tmp/go-pmtiles.tar.gz \
  https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz \
  && tar -xzf /tmp/go-pmtiles.tar.gz -C /tmp && mv /tmp/pmtiles /usr/local/bin/pmtiles \
  && chmod +x /usr/local/bin/pmtiles && rm /tmp/go-pmtiles.tar.gz
ENV PMTILES_BIN=/usr/local/bin/pmtiles

EXPOSE 8080

WORKDIR /app/api
RUN useradd -m -s /bin/bash bun && mkdir -p .cache && chown -R bun:bun .cache

USER bun

CMD ["bun", "run", "src/main.ts"]
