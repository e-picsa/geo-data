# docker build -t epicsa-geo-api .
# docker run --rm -p 8080:8080 epicsa-geo-api

# ---- Build stage ----
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY api/package.json ./api/
COPY web/package.json ./web/

RUN bun install --frozen-lockfile --production --ignore-scripts

# ---- Runtime stage ----
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/node_modules ./api/node_modules
COPY package.json ./
COPY api/package.json ./api/
COPY api/src ./api/src

EXPOSE 8080
USER bun

WORKDIR /app/api
CMD ["bun", "run", "src/main.ts"]
