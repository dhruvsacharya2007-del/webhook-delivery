#!/usr/bin/env node
/**
 * Attempt exactly one delivery, then exit.
 *
 *   npm run deliver:once              -> oldest delivery that is due
 *   npm run deliver:once <deliveryId> -> that specific delivery
 *
 * Note what is NOT in this file: no Express, no req, no res, no HTTP server.
 * It calls the same delivery.service the Day 3 worker will call. That is the
 * point — business logic that only works behind an HTTP handler could not be
 * reused by a background worker.
 *
 * This is effectively the worker's inner loop. Day 3 wraps it in a polling
 * loop with row-level locking; the work itself does not change.
 */

const prisma = require('../src/lib/prisma');
const logger = require('../src/lib/logger');
const deliveryRepository = require('../src/repositories/delivery.repository');
const deliveryService = require('../src/services/delivery.service');

async function resolveDeliveryId() {
  // process.argv is [node, script, ...args] — so the first real arg is index 2.
  const explicitId = process.argv[2];
  if (explicitId) return explicitId;

  const due = await deliveryRepository.findNextDue();
  return due ? due.id : null;
}

async function main() {
  const deliveryId = await resolveDeliveryId();

  if (!deliveryId) {
    console.log('Nothing to deliver: no PENDING delivery with nextRetryAt <= now().');
    return;
  }

  console.log(`Attempting delivery ${deliveryId} ...`);

  const result = await deliveryService.attemptDelivery(deliveryId);

  console.log('\n--- result ---');
  console.log(`  outcome     : ${result.outcome}`);
  console.log(`  statusCode  : ${result.statusCode ?? '(none — timeout or network error)'}`);
  console.log(`  attempt #   : ${result.attemptNumber}`);
  console.log(`  duration    : ${result.durationMs}ms`);
  if (result.error) console.log(`  error       : ${result.error}`);

  console.log('\n  Day 4 will turn "retryable" into a scheduled retry with backoff.');
}

main()
  .catch((err) => {
    logger.error({ err }, 'deliverOnce failed');
    // Set exitCode rather than calling process.exit(): exit() terminates
    // immediately and can truncate pending stdout writes and the disconnect
    // below. Setting the code lets Node exit naturally once work is done.
    process.exitCode = 1;
  })
  .finally(async () => {
    // A server holds the connection pool open for its lifetime; a script must
    // release it. Without this the process stays alive with an open handle.
    await prisma.$disconnect();
  });