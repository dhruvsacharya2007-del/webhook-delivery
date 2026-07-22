const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const { createEndpoint } = require('./helpers');

const post = (body, key) => {
  const req = request(app).post('/events').set('Content-Type', 'application/json');
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};
const EVENT = { eventType: 'payment.succeeded', payload: { amount: 2000, currency: 'usd' } };

describe('POST /events — idempotent ingestion', () => {
  test('first ingest creates the event and fans out to subscribers', async () => {
    await createEndpoint({ eventTypes: ['payment.succeeded'] });
    const res = await post(EVENT, 'key-1');
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.deliveryCount).toBe(1);
  });

  test('SAME key + SAME payload is a replay: one event, 200, duplicate=true', async () => {
    await createEndpoint();
    const first = await post(EVENT, 'key-2');
    const replay = await post({ eventType: 'payment.succeeded', payload: { currency: 'usd', amount: 2000 } }, 'key-2'); // reordered keys
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.eventId).toBe(first.body.eventId);
    const rows = await prisma.$queryRaw`SELECT COUNT(*)::int c FROM events`;
    expect(rows[0].c).toBe(1); // NOT two
  });

  test('SAME key + DIFFERENT payload is a client error: 422', async () => {
    await createEndpoint();
    await post(EVENT, 'key-3');
    const conflict = await post({ eventType: 'payment.succeeded', payload: { amount: 9999 } }, 'key-3');
    expect(conflict.status).toBe(422);
  });

  test('missing Idempotency-Key is rejected with 400', async () => {
    const res = await post(EVENT);
    expect(res.status).toBe(400);
  });

  test('zero matching subscribers still succeeds with deliveryCount 0', async () => {
    const res = await post({ eventType: 'nobody.listening', payload: {} }, 'key-4');
    expect(res.status).toBe(201);
    expect(res.body.deliveryCount).toBe(0);
  });
});