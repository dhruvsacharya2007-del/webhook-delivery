require('./setup-env');

const prisma = require('../src/lib/prisma');

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE deliveries,
                   delivery_attempts,
                   events,
                   endpoints
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});