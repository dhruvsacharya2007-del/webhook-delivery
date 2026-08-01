require('./setup-db');
const prisma = require('../src/lib/prisma');
const { createEndpoint, uuid } = require('./helpers');
const deliveryRepo = require('../src/repositories/delivery.repository');

async function createPendingDelivery(endpointId, endpointSeq) {
  const eventId = uuid();
  await prisma.event.create({
    data: {
      id: eventId,
      eventType: 'fairness.test',
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
      endpointSeq,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

describe('fair scheduling', () => {
  test('minnow deliveries are claimed before whale backlog despite later creation', async () => {
    const whale = await createEndpoint({ eventTypes: ['fairness.test'] });
    const minnow = await createEndpoint({ eventTypes: ['fairness.test'] });

    // Whale has a large backlog (seq 1-20)
    for (let i = 1; i <= 20; i++) {
      await createPendingDelivery(whale.id, i);
    }

    // Minnow has 3 deliveries (seq 1-3) — created AFTER whale
    for (let i = 1; i <= 3; i++) {
      await createPendingDelivery(minnow.id, i);
    }

    // Claim a small batch (5) — should interleave: seq 1 from both endpoints
    // come before seq 2 from either, etc.
    const claimed = await deliveryRepo.claimDeliveries(5);
    expect(claimed.length).toBe(5);

    // Look up which endpoints the claimed deliveries belong to
    const claimedDeliveries = await prisma.delivery.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
      select: { endpointId: true, endpointSeq: true },
      orderBy: { endpointSeq: 'asc' },
    });

    // Minnow's deliveries (seq 1-3) should ALL be in the first batch,
    // because they interleave with the whale's matching seq values
    const minnowClaimed = claimedDeliveries.filter(
      (d) => d.endpointId === minnow.id,
    );
    expect(minnowClaimed.length).toBeGreaterThanOrEqual(2);

    // All claimed deliveries should have low endpointSeq (interleaved, not whale-first)
    const maxSeq = Math.max(...claimedDeliveries.map((d) => d.endpointSeq));
    expect(maxSeq).toBeLessThanOrEqual(3);
  });

  test('claim uses index scan on the fairness index (not seq scan + sort)', async () => {
    const endpoint = await createEndpoint({ eventTypes: ['fairness.test'] });
    await createPendingDelivery(endpoint.id, 1);

    const plan = await prisma.$queryRaw`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM deliveries
      WHERE status = 'PENDING'::"DeliveryStatus"
        AND "nextRetryAt" <= NOW()
      ORDER BY "endpointSeq" ASC NULLS LAST, "nextRetryAt" ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    `;

    const planText = JSON.stringify(plan);
    expect(planText).toContain('deliveries_status_endpointSeq_nextRetryAt_idx');
    expect(planText).not.toContain('"Node Type": "Sort"');
  });
});