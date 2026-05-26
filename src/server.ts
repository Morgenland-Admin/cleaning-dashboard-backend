import { buildApp } from './app.js';
import { env } from './config/env.js';
import { startExportWorker, stopExportWorker } from './lib/exports.js';

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  startExportWorker();

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void (async () => {
        app.log.info(`Received ${sig}, shutting down...`);
        stopExportWorker();
        await app.close();
        process.exit(0);
      })();
    });
  }
}

void main();
