const prisma = require('../lib/prisma');
const { Prisma } = require('../generated/prisma');
const env = require('../config/env');

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
      SELECT dd.id FROM deliveries dd
      JOIN endpoints e ON e.id = dd."endpointId"
      WHERE dd.status = 'PENDING'::"DeliveryStatus"
        AND dd."nextRetryAt" <= NOW()
        AND (e."breakerOpenUntil" IS NULL OR e."breakerOpenUntil" <= NOW())
      ORDER BY dd."endpointSeq" ASC NULLS LAST, dd."nextRetryAt" ASC
      LIMIT ${batchSize}
       FOR UPDATE OF dd SKIP LOCKED
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




function listFailed({ endpointId, failureReason, cursorCreatedAt, cursorId, limit }, client = prisma) {
  // Parameterised via Prisma.sql fragments so optional filters compose safely.
  const conditions = [Prisma.sql`d.status = 'FAILED'::"DeliveryStatus"`];
 
  if (endpointId) {
    conditions.push(Prisma.sql`d."endpointId" = ${endpointId}`);
  }
  if (failureReason) {
    conditions.push(Prisma.sql`d."failureReason" = ${failureReason}::"FailureReason"`);
  }
  if (cursorCreatedAt && cursorId) {
    conditions.push(
      Prisma.sql`(d."createdAt", d.id) < (${cursorCreatedAt}, ${cursorId})`,
    );
  }
 
  const where = Prisma.join(conditions, ' AND ');
 
  return client.$queryRaw`
    SELECT d.id, d."eventId", d."endpointId", d.status, d."attemptCount",
           d."failureReason", d."createdAt", d."updatedAt",
           e.url AS "endpointUrl", ev."eventType"
    FROM deliveries d
    JOIN endpoints e ON e.id = d."endpointId"
    JOIN events ev ON ev.id = d."eventId"
    WHERE ${where}
    ORDER BY d."createdAt" DESC, d.id DESC
    LIMIT ${limit}
  `;
}
 

function redriveOne(id, client = prisma) {
  return client.$queryRaw`
    UPDATE deliveries
    SET status = 'PENDING'::"DeliveryStatus",
        "attemptCount" = 0,
        "nextRetryAt" = NOW(),
        "claimedAt" = NULL,
        "failureReason" = NULL,
        "updatedAt" = NOW()
    WHERE id = ${id}
      AND status = 'FAILED'::"DeliveryStatus"
    RETURNING id
  `;
}
 

function redriveExhaustedForEndpoint(endpointId, client = prisma) {
  return client.$queryRaw`
    UPDATE deliveries
    SET status = 'PENDING'::"DeliveryStatus",
        "attemptCount" = 0,
        "nextRetryAt" = NOW(),
        "claimedAt" = NULL,
        "failureReason" = NULL,
        "updatedAt" = NOW()
    WHERE "endpointId" = ${endpointId}
      AND status = 'FAILED'::"DeliveryStatus"
      AND "failureReason" = 'RETRIES_EXHAUSTED'::"FailureReason"
    RETURNING id
  `;
}

function findById(id, client = prisma) {
  return client.delivery.findUnique({
    where: { id },
  });
}

function getBacklogCounts(client = prisma) {
  return client.$queryRaw`
    SELECT
      count(*) FILTER (WHERE "nextRetryAt" <= NOW()) AS claimable,
      count(*) FILTER (WHERE "nextRetryAt" >  NOW()) AS scheduled
    FROM deliveries
    WHERE status = 'PENDING'::"DeliveryStatus"
  `;
}
function applyBatchWrites(writes, endpointDeltas, client = prisma) {
  return client.$transaction(async (tx) => {
    await tx.deliveryAttempt.createMany({ data: writes.map((w) => w.attemptRow) });
    for (const w of writes) {
      await tx.delivery.update({ where: { id: w.statusUpdate.id }, data: w.statusUpdate.data });
    }

    for (const [endpointId, delta] of endpointDeltas) {
      await tx.$executeRaw`
        WITH computed AS (
          SELECT id, GREATEST(0, "failureCount" + ${delta}) AS new_count
          FROM endpoints
          WHERE id = ${endpointId}
          FOR UPDATE
        )
        UPDATE endpoints e
        SET "failureCount" = CASE
              WHEN c.new_count >= ${env.BREAKER_FAILURE_THRESHOLD} THEN 0
              ELSE c.new_count
            END,
            "breakerOpenUntil" = CASE
              WHEN c.new_count >= ${env.BREAKER_FAILURE_THRESHOLD}
              THEN NOW() + (${env.BREAKER_COOLDOWN_SECONDS} * INTERVAL '1 second')
              ELSE e."breakerOpenUntil"
            END
        FROM computed c
        WHERE e.id = c.id
      `;
    }
  });
}
module.exports = {
  createMany,
  countByEventId,
  findByIdWithRelations,
  findNextDue,
  claimDeliveries,
  reapStuckDeliveries,
  listFailed,
  redriveOne,
  redriveExhaustedForEndpoint,
  updateStatus,
  recordAttempt,
  findById,
  getBacklogCounts,
  applyBatchWrites
};
 
 
 