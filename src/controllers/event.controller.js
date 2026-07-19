const eventService = require('../services/event.service');


async function createEvent(req, res) {
  
  const idempotencyKey = req.headers['idempotency-key'];
  const { eventType, payload } = req.body;

  const { event, deliveryCount, isDuplicate } = await eventService.createEvent({
    eventType,
    payload,
    idempotencyKey,
  });

  res.status(isDuplicate ? 200 : 201).json({
    eventId: event.id,
    eventType: event.eventType,
    deliveryCount,
    duplicate: isDuplicate,
    createdAt: event.createdAt,
  });
}

module.exports = {
  createEvent,
};