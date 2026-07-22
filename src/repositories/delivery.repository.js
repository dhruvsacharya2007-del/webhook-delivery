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

              

function claimDeliveries(batchSize, client = prisma) {
  return client.$queryRaw`
    UPDATE deliveries d
    SET status = 'DELIVERING'::"DeliveryStatus",
        "claimedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE d.id IN (
      SELECT id FROM deliveries
      WHERE status = 'PENDING'::"DeliveryStatus"
        AND "nextRetryAt" <= NOW()
      ORDER BY "nextRetryAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING d.id
  `;
}



function reapStuckDeliveries(visibilityTimeoutSeconds, client = prisma) {
  return client.$queryRaw`
    UPDATE deliveries
    SET status = 'PENDING'::"DeliveryStatus",
        "claimedAt" = NULL,
        "attemptCount" = "attemptCount" + 1,
        "updatedAt" = NOW()
    WHERE status = 'DELIVERING'::"DeliveryStatus"
      AND "claimedAt" < NOW() - (${visibilityTimeoutSeconds} * INTERVAL '1 second')
    RETURNING id
  `;
}
 
module.exports = {
  createMany,
  countByEventId,
  findByIdWithRelations,
  findNextDue,
  claimDeliveries,
  reapStuckDeliveries,
  updateStatus,
  recordAttempt,
};
 