const prisma = require('../lib/prisma');


function create(data, client = prisma) {
  return client.event.create({ data });
}


function findByIdempotencyKey(idempotencyKey, client = prisma) {
  return client.event.findUnique({ where: { idempotencyKey } });
}

module.exports = {
  create,
  findByIdempotencyKey,
};