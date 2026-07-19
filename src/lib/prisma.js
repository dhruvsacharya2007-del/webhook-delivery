const { PrismaClient } = require('../generated/prisma');
const env = require('../config/env');

const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = prisma;