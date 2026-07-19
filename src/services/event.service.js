const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { AppError } = require('../middleware/errorHandler');
const { generateRequestFingerprint } = require('../lib/fingerprint');
const eventRepository = require('../repositories/event.repository');
const endpointRepository = require('../repositories/endpoint.repository');
const deliveryRepository = require('../repositories/delivery.repository');


const PRISMA_UNIQUE_VIOLATION = 'P2002';

function isIdempotencyKeyViolation(err) {
  if (err?.code !== PRISMA_UNIQUE_VIOLATION) return false;

  const target = err?.meta?.target;
  if (!target) return true; // Event has exactly one unique column

  return Array.isArray(target)
    ? target.includes('idempotencyKey')
    : String(target).includes('idempotencyKey');
}

/**
 * Ingest an event idempotently and fan it out to subscribed endpoints.
 *
 * @param {{ eventType: string, payload: object, idempotencyKey: string }} input
 * @returns {Promise<{ event: object, deliveryCount: number, isDuplicate: boolean }>}
 */
async function createEvent({ eventType, payload, idempotencyKey }) {
  const requestFingerprint = generateRequestFingerprint({ eventType, payload });

  try {
    
    return await prisma.$transaction(async (tx) => {
     
      const event = await eventRepository.create(
        { eventType, payload, idempotencyKey, requestFingerprint },
        tx,
      );

      const endpoints = await endpointRepository.findEnabledForEventType(eventType, tx);

      
      let deliveryCount = 0;
      if (endpoints.length > 0) {
        const { count } = await deliveryRepository.createMany(
          endpoints.map((endpoint) => ({ eventId: event.id, endpointId: endpoint.id })),
          tx,
        );
        deliveryCount = count;
      }

      return { event, deliveryCount, isDuplicate: false };
    });
  } catch (err) {
    if (!isIdempotencyKeyViolation(err)) throw err;
    return handleDuplicateIngest({ idempotencyKey, requestFingerprint });
  }
}


async function handleDuplicateIngest({ idempotencyKey, requestFingerprint }) {
  const existing = await eventRepository.findByIdempotencyKey(idempotencyKey);

  if (!existing) {
    logger.error({ idempotencyKey }, 'P2002 raised but no event found for key');
    throw new AppError(409, 'Idempotency key conflict, please retry');
  }

  if (existing.requestFingerprint !== requestFingerprint) {
    
    throw new AppError(
      422,
      'This Idempotency-Key was already used with a different request body',
    );
  }

  const deliveryCount = await deliveryRepository.countByEventId(existing.id);

  logger.info({ eventId: existing.id, idempotencyKey }, 'Idempotent replay');

  return { event: existing, deliveryCount, isDuplicate: true };
}

module.exports = {
  createEvent,
};