const http = require('node:http');
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const deliveriesTotal = new client.Counter({
  name: 'deliveries_total',
  help: 'Webhook delivery attempts by outcome (per-attempt).',
  labelNames: ['outcome'],
  registers: [register],
});

const deliveryDuration = new client.Histogram({
  name: 'delivery_duration_seconds',
  help: 'Webhook delivery attempt duration in seconds, by outcome.',
  labelNames: ['outcome'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 11],
  registers: [register],
});

const deliveriesClaimable = new client.Gauge({
  name: 'deliveries_claimable',
  help: 'PENDING deliveries whose nextRetryAt is due now (work waiting for a worker).',
  registers: [register],
});

const deliveriesScheduled = new client.Gauge({
  name: 'deliveries_scheduled',
  help: 'PENDING deliveries deferred to a future nextRetryAt (waiting on backoff).',
  registers: [register],
});

// Shared by API and worker. Returns the server so each caller owns its own handle
// (must NOT be a module-level singleton — two processes call this).
function startMetricsServer(port, logger) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.statusCode = 404;
      return res.end();
    }
    try {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      logger.error({ err }, 'Metrics endpoint failed');
      res.statusCode = 500;
      res.end('metrics collection failed');
    }
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Metrics server listening');
  });
  return server;
}

const workerActiveJobs = new client.Gauge({
  name: 'worker_active_jobs',
  help: 'Deliveries currently being processed by this worker.',
  registers: [register],
});

const workerPollCycles = new client.Counter({
  name: 'worker_poll_cycles_total',
  help: 'Worker poll-loop iterations. A flat rate() means the worker has stopped polling.',
  registers: [register],
});

module.exports = {
  register,
  deliveriesTotal,
  deliveryDuration,
  deliveriesClaimable,
  deliveriesScheduled,
  startMetricsServer,
  workerPollCycles,
  workerActiveJobs,
};