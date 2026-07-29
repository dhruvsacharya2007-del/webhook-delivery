const logger = require('./logger');
const deliveryRepository = require('../repositories/delivery.repository');
const { deliveriesClaimable, deliveriesScheduled } = require('./metrics');

const REFRESH_INTERVAL_MS = 30000;
let timer = null;

async function refresh() {
  try {
    const [row] = await deliveryRepository.getBacklogCounts();
    
    deliveriesClaimable.set(Number(row.claimable));
    deliveriesScheduled.set(Number(row.scheduled));
  } catch (err) {
    
    logger.error({ err }, 'Backlog metrics refresh failed');
  }
}

function startBacklogMetricsRefresher() {
  refresh();                                 
  timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  logger.info({ intervalMs: REFRESH_INTERVAL_MS }, 'Backlog metrics refresher started');
}

function stopBacklogMetricsRefresher() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startBacklogMetricsRefresher, stopBacklogMetricsRefresher };