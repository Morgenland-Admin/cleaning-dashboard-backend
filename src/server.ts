import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/index.js';
import { startExportWorker, stopExportWorker } from './lib/exports.js';
import { startDunningWorker, stopDunningWorker } from './lib/dunning.js';

// Single-replica only: chat hub and caches are in-process (needs Redis to scale out).
const SHUTDOWN_DEADLINE_MS = 15_000;

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  startExportWorker();
  startDunningWorker();

  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Never hang past the deadline on a stuck close.
      const deadline = setTimeout(() => {
        console.error(`Shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`);
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS);
      deadline.unref?.();
      void (async () => {
        app.log.info(`Received ${sig}, shutting down...`);
        stopExportWorker();
        await stopDunningWorker(); // drain any in-flight sweep before closing the pool
        await app.close();
        await pool.end();
        process.exit(0);
      })();
    });
  }
}

void main();
