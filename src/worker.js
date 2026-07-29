

const env = require('./config/env');
const logger = require('./lib/logger');
const prisma = require('./lib/prisma');
const deliveryRepository = require('./repositories/delivery.repository');
const deliveryService = require('./services/delivery.service');
const http = require('node:http');
const { startMetricsServer, workerActiveJobs, workerPollCycles } = require('./lib/metrics');




let metricsServer = null;



const BATCH_SIZE = env.WORKER_BATCH_SIZE;

const IDLE_POLL_MS = env.WORKER_IDLE_POLL_MS;

const ERROR_BACKOFF_MS = 5000;

let running = true;
let currentBatch = null;
let interruptSleep = null;
let reaperTimer = null;


function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    interruptSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * Claim a batch and deliver all of it concurrently.
 * @returns {Promise<number>} how many deliveries were claimed
 */
async function processBatch() {
  const claimed = await deliveryRepository.claimDeliveries(BATCH_SIZE);

  if (claimed.length === 0) return 0;

  logger.debug({ count: claimed.length }, 'Claimed deliveries');

  // allSettled, NOT all. Promise.all rejects as soon as one promise rejects and
  // abandons the rest — their outcomes would never be recorded and their rows
  // would stay stuck in DELIVERING. allSettled waits for every one.
  const results = await Promise.allSettled(
      claimed.map(({ id }) => {
      workerActiveJobs.inc();
      return deliveryService
      .attemptDelivery(id)
      .finally(() => workerActiveJobs.dec());
    })
  );

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      // attemptDelivery handles HTTP failures internally, so a rejection here
      // means something lower-level broke (database, missing row).
      logger.error(
        { deliveryId: claimed[index].id, err: result.reason },
        'Delivery attempt threw',
      );
    }
  }

  return claimed.length;
}

 

async function runReaper() {
  try {
    const reaped = await deliveryRepository.reapStuckDeliveries(
      env.VISIBILITY_TIMEOUT_SECONDS,
    );
 
    if (reaped.length > 0) {
      // Worth logging loudly: this means a worker died holding work. It also
      // means those deliveries may be sent twice, since we cannot know whether
      // the original attempt reached the subscriber before the worker died.
      logger.warn(
        {
          count: reaped.length,
          deliveryIds: reaped.map((r) => r.id),
          visibilityTimeoutSeconds: env.VISIBILITY_TIMEOUT_SECONDS,
        },
        'Reaped stuck deliveries from a presumed-dead worker',
      );
    }
  } catch (err) {
    // A failing reaper must not kill the worker; delivery still works without it.
    logger.error({ err }, 'Reaper failed');
  }
}


async function loop() {
  logger.info(
    {
      batchSize: BATCH_SIZE,
      idlePollMs: IDLE_POLL_MS,
      visibilityTimeoutSeconds: env.VISIBILITY_TIMEOUT_SECONDS,
      reaperIntervalMs: env.REAPER_INTERVAL_MS,
    },
    'Worker started',
  );

  metricsServer = startMetricsServer(env.METRICS_PORT, logger);
 
  // Sweep once at boot: if THIS worker was the one that just died and got
  // restarted, its own stranded rows are waiting.
  await runReaper();
  reaperTimer = setInterval(runReaper, env.REAPER_INTERVAL_MS);
 
  while (running) {
    workerPollCycles.inc();
    try {
      currentBatch = processBatch();
      const processed = await currentBatch;
      currentBatch = null;
 
      // Only pause when there was nothing to do.
      if (processed === 0 && running) await sleep(IDLE_POLL_MS);
    } catch (err) {
      currentBatch = null;
      logger.error({ err }, 'Worker loop error');
      if (running) await sleep(ERROR_BACKOFF_MS);
    }
  }
 
  logger.info('Worker loop exited');
}


async function shutdown(signal) {
  if (!running) return; 
  running = false;
 
  logger.info({ signal }, 'Shutdown requested, finishing in-flight work');
 
  
  if (interruptSleep) interruptSleep();
  if (reaperTimer) clearInterval(reaperTimer);
  if (metricsServer) metricsServer.close();
 
  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 15000);
  forceExit.unref();
 
  try {
    if (currentBatch) await currentBatch;
  } catch (err) {
    logger.error({ err }, 'In-flight batch failed during shutdown');
  }
 
  await prisma.$disconnect();
  clearTimeout(forceExit);
  logger.info('Worker shut down cleanly');
  process.exit(0);
}
 
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}
 
loop().catch(async (err) => {
  logger.fatal({ err }, 'Worker crashed');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});