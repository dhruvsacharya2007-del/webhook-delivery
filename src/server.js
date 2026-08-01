const app = require('./app');
const env = require('./config/env');
const logger = require('./lib/logger');
const prisma = require('./lib/prisma');
const { startMetricsServer } = require('./lib/metrics');
const { startBacklogMetricsRefresher, stopBacklogMetricsRefresher } = require('./lib/backlog-metrics');

const server = app.listen(env.PORT, '0.0.0.0', () =>{
  logger.info(`Server listening on port ${env.PORT}`);
});

const metricsServer = startMetricsServer(env.METRICS_PORT, logger);
startBacklogMetricsRefresher();

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  stopBacklogMetricsRefresher();     // stop the timer BEFORE draining
  metricsServer.close();
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Closed out remaining connections');
    process.exit(0);
  });
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

module.exports = server;