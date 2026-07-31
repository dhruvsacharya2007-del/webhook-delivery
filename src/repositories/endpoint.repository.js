const prisma = require('../lib/prisma');



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
function incrementDeliverySequence(endpointId, client = prisma) {
  return client.endpoint.update({
    where: { id: endpointId },
    data: { deliverySequence: { increment: 1 } },
    select: { deliverySequence: true },
  });
}


module.exports = {
  create,
  findEnabledForEventType,
  incrementDeliverySequence,
};