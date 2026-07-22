
require('./setup-env');
const request = require('supertest');
const app = require('../src/app');

const prisma = require('../src/lib/prisma');
const { createEndpoint, createFailedDelivery } = require('./helpers');

const getRow = async (id) => (await prisma.$queryRaw`SELECT * FROM deliveries WHERE id = ${id}`)[0];

describe('POST /deliveries/:id/redrive', () => {
  test('resets a FAILED delivery to the queue initial state', async () => {
    const ep = await createEndpoint();
    const del = await createFailedDelivery(ep.id, { attemptCount: 4, failureReason: 'RETRIES_EXHAUSTED' });

    const res = await request(app).post(`/deliveries/${del.id}/redrive`);
    expect(res.status).toBe(200);

    const row = await getRow(del.id);
    expect(row.status).toBe('PENDING');        
    expect(row.attemptCount).toBe(0);          
    expect(row.failureReason).toBeNull();     
    expect(row.claimedAt).toBeNull();
  });

  test('double redrive: second call is 409 (nothing to redrive)', async () => {
    const ep = await createEndpoint();
    const del = await createFailedDelivery(ep.id);
    expect((await request(app).post(`/deliveries/${del.id}/redrive`)).status).toBe(200);
    expect((await request(app).post(`/deliveries/${del.id}/redrive`)).status).toBe(409);
  });

  test('unknown delivery is 404', async () => {
    const res = await request(app).post('/deliveries/00000000-0000-4000-8000-000000000000/redrive');
    expect(res.status).toBe(404);
  });

  test('non-uuid id is rejected with 400', async () => {
    expect((await request(app).post('/deliveries/not-a-uuid/redrive')).status).toBe(400);
  });
});

describe('POST /endpoints/:id/redrive — bulk, reason-scoped', () => {
  test('redrives RETRIES_EXHAUSTED but NOT ENDPOINT_REJECTED', async () => {
    const ep = await createEndpoint();
    const exhausted = await createFailedDelivery(ep.id, { failureReason: 'RETRIES_EXHAUSTED' });
    const rejected  = await createFailedDelivery(ep.id, { failureReason: 'ENDPOINT_REJECTED' });

    const res = await request(app).post(`/endpoints/${ep.id}/redrive`);
    expect(res.status).toBe(200);
    expect(res.body.redrivenCount).toBe(1);

    expect((await getRow(exhausted.id)).status).toBe('PENDING'); // requeued
    expect((await getRow(rejected.id)).status).toBe('FAILED');   // left alone — needs a human
  });
});

describe('GET /deliveries — dead-letter list', () => {
  test('lists only FAILED, filters by reason, paginates', async () => {
    const ep = await createEndpoint();
    for (let i = 0; i < 3; i++) await createFailedDelivery(ep.id, { failureReason: 'RETRIES_EXHAUSTED' });
    await createFailedDelivery(ep.id, { failureReason: 'ENDPOINT_REJECTED' });

    const all = await request(app).get('/deliveries?status=FAILED');
    expect(all.body.data).toHaveLength(4);

    const rejected = await request(app).get('/deliveries?status=FAILED&failureReason=ENDPOINT_REJECTED');
    expect(rejected.body.data).toHaveLength(1);

    const page1 = await request(app).get('/deliveries?status=FAILED&limit=2');
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination.hasMore).toBe(true);
    const page2 = await request(app).get(`/deliveries?status=FAILED&limit=2&cursor=${page1.body.pagination.nextCursor}`);
    expect(page2.body.data).toHaveLength(2);
    // no overlap between pages
    const ids = new Set([...page1.body.data, ...page2.body.data].map(d => d.id));
    expect(ids.size).toBe(4);
  });

  test('rejects a non-FAILED status with 400', async () => {
    expect((await request(app).get('/deliveries?status=PENDING')).status).toBe(400);
  });
});