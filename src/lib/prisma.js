const { PrismaClient } = require('../generated/prisma');
const env = require('../config/env');

const url = new URL(env.DATABASE_URL);
url.searchParams.set('connection_limit', String(env.DB_CONNECTION_LIMIT));

const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  datasources: { db: { url: url.toString() } },
});

module.exports = prisma;