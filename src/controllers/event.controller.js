const crypto = require('node:crypto');
const eventService = require('../services/event.service');

async function createEvent(req, res) {
  const idempotencyKey = req.headers['idempotency-key'];

  const correlationId = req.headers['x-request-id'] || crypto.randomUUID();
  const { eventType, payload } = req.body;

  const { event, deliveryCount, isDuplicate } = await eventService.createEvent({
    eventType,
    payload,
    idempotencyKey,
    correlationId,
  });

  
  res.setHeader('X-Request-Id', event.correlationId);
  res.status(isDuplicate ? 200 : 201).json({
    eventId: event.id,
    eventType: event.eventType,
    correlationId: event.correlationId,
    deliveryCount,
    duplicate: isDuplicate,
    createdAt: event.createdAt,
  });
}

module.exports = {
  createEvent,
};