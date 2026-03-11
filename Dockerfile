# ---- Build stage ----
FROM oven/bun:1 AS build
WORKDIR /app

COPY api/package.json ./package.json
COPY bun.lock ./

RUN bun install --frozen-lockfile

# ---- Runtime stage ----
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY api/src src

EXPOSE 8080
USER bun

CMD ["bun", "run", "src/main.ts"]
