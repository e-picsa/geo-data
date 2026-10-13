import { appRouter } from './routes/index.ts';

const port = parseInt(process.env.PORT ?? '5174');

const VERSION = 20260306;

console.log('Serve api version ' + VERSION);

const server = Bun.serve({
  port,
  fetch: appRouter,
});

console.log(`Server listening at http://localhost:${server.port}`);
console.log(`Health check: http://localhost:${server.port}/health`);
