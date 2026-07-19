const prisma = require('../lib/prisma');

/**
 * Insert an event.
 *
 * No duplicate check here. The UNIQUE constraint on idempotencyKey is what
 * makes ingestion race-safe: concurrent duplicates are serialized by the index
 * and the loser throws P2002, which the service translates. A findUnique-then-
 * create in this layer would reintroduce the check-then-insert race.
 *
 * @param {{ eventType: string, payload: object, idempotencyKey: string, requestFingerprint: string }} data
 */
function create(data, client = prisma) {
  return client.event.create({ data });
}

/**
 * Look up the event an idempotency key already produced.
 * Called on the duplicate path, after a P2002 violation.
 */
function findByIdempotencyKey(idempotencyKey, client = prisma) {
  return client.event.findUnique({ where: { idempotencyKey } });
}

module.exports = {
  create,
  findByIdempotencyKey,
};