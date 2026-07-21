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

/**
 * Atomically claim up to `batchSize` due deliveries for this worker.
 *
 * Raw SQL because Prisma's query API cannot express FOR UPDATE SKIP LOCKED.
 *
 * How it works, and why each piece matters:
 *
 *   FOR UPDATE          locks the selected rows so no other transaction can
 *                       take them. Without any locking, two workers running
 *                       this at the same instant BOTH get the same rows and
 *                       the subscriber receives the webhook twice.
 *
 *   SKIP LOCKED         rows already locked by another worker are skipped as
 *                       if they did not exist, instead of waiting for them.
 *                       Plain FOR UPDATE is correct but serialises workers
 *                       into a convoy — measured at ~1300ms of blocking vs
 *                       ~48ms with SKIP LOCKED.
 *
 *   UPDATE ... RETURNING  select, lock, update and return in ONE statement,
 *                       which is atomic without an explicit transaction and
 *                       holds the lock for the shortest possible window.
 *
 * The transaction ends when this statement returns — BEFORE any HTTP call.
 * We deliberately do not hold a database transaction open across network I/O:
 * that would tie up a pooled connection for the full 10s timeout and hold back
 * the vacuum horizon. The cost is that a worker killed mid-delivery strands its
 * row in DELIVERING, which is what claimedAt and the reaper exist to fix.
 *
 * Note: identifiers are quoted because Postgres folds unquoted names to
 * lowercase, and Prisma created camelCase columns and a "DeliveryStatus" enum.
 *
 * Note: "updatedAt" is set explicitly. Prisma's @updatedAt is applied by the
 * client, not the database, so raw SQL bypasses it.
 *
 * @returns {Promise<Array<{id: string}>>}
 */
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
 