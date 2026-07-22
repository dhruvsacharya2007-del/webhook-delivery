require('./setup-env');

const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const crypto = require('node:crypto');

const uuid = () => crypto.randomUUID();

async function createEndpoint(overrides = {}) {
  return prisma.endpoint.create({
    data: {
      id: uuid(),
      url: overrides.url || 'http://localhost:9/webhook',
      signingSecret: overrides.signingSecret || `whsec_${'a'.repeat(64)}`,
      eventTypes: overrides.eventTypes || ['payment.succeeded'],
      enabled: overrides.enabled ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

async function createFailedDelivery(endpointId, overrides = {}) {
  const eventId = uuid();
  await prisma.event.create({
    data: { id: eventId, eventType: 'payment.succeeded', payload: {}, idempotencyKey: uuid(), requestFingerprint: 'f', createdAt: new Date() },
  });
  return prisma.delivery.create({
    data: {
      id: uuid(), eventId, endpointId,
      status: 'FAILED', attemptCount: overrides.attemptCount ?? 4,
      failureReason: overrides.failureReason || 'RETRIES_EXHAUSTED',
      nextRetryAt: new Date(), createdAt: overrides.createdAt || new Date(), updatedAt: new Date(),
    },
  });
}

module.exports = { uuid, createEndpoint, createFailedDelivery };