const prisma = require('../lib/prisma');

/**
 * Data access for the Delivery aggregate.
 * The Day 3 worker will add claim/update functions here.
 */

/**
 * Bulk-insert the fan-out rows for one event.
 *
 * createMany issues a single multi-row INSERT rather than N round trips —
 * meaningful when an event fans out to hundreds of endpoints.
 *
 * skipDuplicates leans on @@unique([eventId, endpointId]): if fan-out ever runs
 * twice for the same event, the second run inserts nothing instead of throwing.
 * Idempotency at the delivery layer, enforced by the database.
 *
 * Returns { count } — Postgres createMany does not return the inserted rows.
 *
 * @param {Array<{ eventId: string, endpointId: string }>} deliveries
 */
function createMany(deliveries, client = prisma) {
  return client.delivery.createMany({
    data: deliveries,
    skipDuplicates: true,
  });
}

/**
 * How many deliveries exist for an event.
 *
 * Used on the duplicate-ingest path: a retry creates nothing, so reporting
 * "deliveriesCreated: 0" would be misleading. Reporting the event's actual
 * delivery count keeps the response shape meaningful on both paths.
 */
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

/**
 * Update a delivery's status (and any other lifecycle fields).
 * Scheduling policy (nextRetryAt, backoff) is Day 4's concern, not this layer's.
 */
function updateStatus(id, data, client = prisma) {
  return client.delivery.update({ where: { id }, data });
}

/**
 * Append one row to the attempt log.
 *
 * DeliveryAttempt lives in THIS repository rather than its own: Delivery is the
 * aggregate root and an attempt has no meaning outside its delivery. Repository
 * per aggregate root, not per table.
 */
function recordAttempt(data, client = prisma) {
  return client.deliveryAttempt.create({ data });
}

module.exports = {
  createMany,
  countByEventId,
  findByIdWithRelations,
  updateStatus,
  recordAttempt,
};