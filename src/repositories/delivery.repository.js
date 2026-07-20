const prisma = require('../lib/prisma');


function createMany(deliveries, client = prisma) {
  return client.delivery.createMany({
    data: deliveries,
    skipDuplicates: true,
  });
}


function countByEventId(eventId, client = prisma) {
  return client.delivery.count({ where: { eventId } });
}

/**
 * Load a delivery together with everything needed to send it: the event (for
 * the body) and the endpoint (for the URL and signing secret).
 *
 * One query with joins rather than three round trips.
 */
function findByIdWithRelations(id, client = prisma) {
  return client.delivery.findUnique({
    where: { id },
    include: { event: true, endpoint: true },
  });
}


function updateStatus(id, data, client = prisma) {
  return client.delivery.update({ where: { id }, data });
}


function recordAttempt(data, client = prisma) {
  return client.deliveryAttempt.create({ data });
}


function findNextDue(now = new Date(), client = prisma) {
  return client.delivery.findFirst({
    where: {
      status: 'PENDING',
      nextRetryAt: { lte: now },
    },
    orderBy: { nextRetryAt: 'asc' },
  });
}

module.exports = {
  createMany,
  countByEventId,
  findByIdWithRelations,
  findNextDue,
  updateStatus,
  recordAttempt,
};