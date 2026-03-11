# ---- Build stage ----
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY api/package.json ./api/
COPY web/package.json ./web/

RUN bun install --frozen-lockfile

# ---- Runtime stage ----
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=build /app/api/node_modules ./node_modules
COPY api/package.json package.json
COPY api/src src

EXPOSE 8080
USER bun

CMD ["bun", "run", "src/main.ts"]
