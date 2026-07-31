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

async function createEvent({ eventType, payload, idempotencyKey, correlationId }) {
  const requestFingerprint = generateRequestFingerprint({ eventType, payload });
  try {
    return await prisma.$transaction(async (tx) => {
      const event = await eventRepository.create(
        { eventType, payload, idempotencyKey, requestFingerprint, correlationId },
        tx,
      );
      const endpoints = await endpointRepository.findEnabledForEventType(eventType, tx);

      let deliveryCount = 0;
      if (endpoints.length > 0) {
        
        const deliveryRows = [];
        for (const endpoint of endpoints) {
          const { deliverySequence } = await endpointRepository.incrementDeliverySequence(
            endpoint.id,
            tx,
          );
          deliveryRows.push({
            eventId: event.id,
            endpointId: endpoint.id,
            correlationId,
            endpointSeq: deliverySequence,
          });
        }
        const { count } = await deliveryRepository.createMany(deliveryRows, tx);
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