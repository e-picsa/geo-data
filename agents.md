# AI Assistants Architecture Guide

Welcome! This system is a monorepo consisting of:
1. `api/` (powered by Bun)
2. `web/` (React + Vite + Tailwind CSS)

## Core Tasks

### The API (Backend)
- Written in TypeScript and runs on **Bun**.
- Uses `Bun.serve()` in `api/src/main.ts` as the webserver.
- The core logic constructs Overpass API queries, then translates them via Mapshaper into TopoJSON.
- Environment variables are accessed via `process.env`. Make sure `OVERPASS_CACHE_BUCKET` is present if you want caching.
- To add dependencies, use `bun add <pkg> --cwd api`.
- To test the API, run `bun test` in the `api` folder.

### The Web (Frontend)
- Written in React + Vite + Tailwind CSS.
- **Vite Proxy:** Vite intercepts calls to `/api` and forwards them to `http://localhost:8080` (the Bun API).
- **Map:** Uses `react-leaflet` to display map bounds. TopoJSON data from the API is first ran through `topojson-client` to render standard GeoJSON paths on Leaflet.
- To add dependencies, use `bun add <pkg> --cwd web` (since shadcn initialization failed, we are avoiding `npx`).
- Styling uses pure Tailwind classes in `className`. 

## Best Practices
- Avoid introducing any heavy DOM libraries into the frontend. The entire application is designed to be lightweight.
- For local dev, run `npm run dev` in the project root to spool up both instances concurrently. 
