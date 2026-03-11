import { appRouter } from './routes/index.ts';

const port = parseInt(process.env.PORT ?? '8080');

const VERSION = 20260306;

console.log('Serve api version ' + VERSION);

Bun.serve({
  port,
  fetch: appRouter,
});
