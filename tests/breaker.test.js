require('./setup-db');
const prisma = require('../src/lib/prisma');
const { createEndpoint, uuid } = require('./helpers');
const deliveryRepo = require('../src/repositories/delivery.repository');

async function createPendingDelivery(endpointId, overrides = {}) {
  const eventId = uuid();
  await prisma.event.create({
    data: {
      id: eventId,
      eventType: 'breaker.test',
      payload: {},
      idempotencyKey: uuid(),
      requestFingerprint: 'f',
      createdAt: new Date(),
    },
  });
  return prisma.delivery.create({
    data: {
      id: uuid(),
      eventId,
      endpointId,
      status: 'PENDING',
      attemptCount: 0,
      nextRetryAt: new Date(Date.now() - 1000), // due now
      endpointSeq: overrides.endpointSeq ?? 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

describe('circuit breaker', () => {
  test('claim excludes deliveries whose endpoint breaker is open', async () => {
    const healthy = await createEndpoint({ eventTypes: ['breaker.test'] });
    const broken = await createEndpoint({ eventTypes: ['breaker.test'] });

    // Open the breaker on the broken endpoint (30s from now)
    await prisma.endpoint.update({
      where: { id: broken.id },
      data: { breakerOpenUntil: new Date(Date.now() + 30_000), failureCount: 0 },
    });

    // Create one delivery for each endpoint
    await createPendingDelivery(healthy.id, { endpointSeq: 1 });
    await createPendingDelivery(broken.id, { endpointSeq: 1 });

    // Claim — should only get the healthy endpoint's delivery
    const claimed = await deliveryRepo.claimDeliveries(10);
    expect(claimed).toHaveLength(1);

    const claimedDelivery = await prisma.delivery.findUnique({
      where: { id: claimed[0].id },
    });
    expect(claimedDelivery.endpointId).toBe(healthy.id);
  });

  test('claim includes deliveries once breaker cooldown expires', async () => {
    const endpoint = await createEndpoint({ eventTypes: ['breaker.test'] });

    // Breaker was open but cooldown is in the PAST (expired)
    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { breakerOpenUntil: new Date(Date.now() - 1000), failureCount: 0 },
    });

    await createPendingDelivery(endpoint.id);

    const claimed = await deliveryRepo.claimDeliveries(10);
    expect(claimed).toHaveLength(1);
  });

  test('claim includes deliveries when breakerOpenUntil is null (never opened)', async () => {
    const endpoint = await createEndpoint({ eventTypes: ['breaker.test'] });
    // breakerOpenUntil defaults to null — should be claimable
    await createPendingDelivery(endpoint.id);

    const claimed = await deliveryRepo.claimDeliveries(10);
    expect(claimed).toHaveLength(1);
  });

  test('applyBatchWrites opens breaker when net failures cross threshold', async () => {
    const endpoint = await createEndpoint({ eventTypes: ['breaker.test'] });
    const delivery = await createPendingDelivery(endpoint.id);

    // Claim it so it's in DELIVERING state
    await deliveryRepo.claimDeliveries(10);

    // Simulate a batch where this endpoint had 6 net failures (above threshold=5)
    const writes = [
      {
        attemptRow: {
          deliveryId: delivery.id,
          attemptNumber: 1,
          statusCode: 500,
          error: 'Internal Server Error',
          durationMs: 50,
        },
        statusUpdate: {
          id: delivery.id,
          data: { attemptCount: 1, status: 'PENDING', claimedAt: null, nextRetryAt: new Date() },
        },
      },
    ];
    const endpointDeltas = new Map([[endpoint.id, 6]]);
    await deliveryRepo.applyBatchWrites(writes, endpointDeltas);

    const updated = await prisma.endpoint.findUnique({ where: { id: endpoint.id } });
    // Breaker should be open (openUntil set in the future) and failureCount reset to 0
    expect(updated.breakerOpenUntil).not.toBeNull();
    expect(updated.breakerOpenUntil.getTime()).toBeGreaterThan(Date.now());
    expect(updated.failureCount).toBe(0);
  });

  test('applyBatchWrites does NOT open breaker when failures stay below threshold', async () => {
    const endpoint = await createEndpoint({ eventTypes: ['breaker.test'] });
    const delivery = await createPendingDelivery(endpoint.id);

    await deliveryRepo.claimDeliveries(10);

    const writes = [
      {
        attemptRow: {
          deliveryId: delivery.id,
          attemptNumber: 1,
          statusCode: 500,
          error: 'Internal Server Error',
          durationMs: 50,
        },
        statusUpdate: {
          id: delivery.id,
          data: { attemptCount: 1, status: 'PENDING', claimedAt: null, nextRetryAt: new Date() },
        },
      },
    ];
    // Only 3 net failures — below threshold of 5
    const endpointDeltas = new Map([[endpoint.id, 3]]);
    await deliveryRepo.applyBatchWrites(writes, endpointDeltas);

    const updated = await prisma.endpoint.findUnique({ where: { id: endpoint.id } });
    expect(updated.breakerOpenUntil).toBeNull();
    expect(updated.failureCount).toBe(3);
  });
});