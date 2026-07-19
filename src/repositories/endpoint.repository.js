const prisma = require('../lib/prisma');


/**
 * Persist a new endpoint.
 * @param {{ url: string, eventTypes: string[], signingSecret: string }} data
 * @returns {Promise<object>} the created endpoint, including signingSecret
 */
function create(data, client = prisma) {
  return client.endpoint.create({ data });
}


 /* PERFORMANCE NOTE: this runs on every ingestion, so it is a hot path. Array
 * containment cannot use a B-tree index; at scale it needs a GIN index on
 * eventTypes. Fine at MVP scale, documented as a known scaling limit.
 */
function findEnabledForEventType(eventType, client = prisma) {
  return client.endpoint.findMany({
    where: {
      enabled: true,
      eventTypes: { has: eventType },
    },
  });
}

module.exports = {
  create,
  findEnabledForEventType,
};