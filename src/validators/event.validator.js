const { z } = require('zod');


const createEventSchema = z.object({
  headers: z.object({
    'idempotency-key': z
      .string({ error: 'Idempotency-Key header is required' })
      .min(1, 'Idempotency-Key header is required')
      
      .max(255, 'Idempotency-Key must be 255 characters or fewer'),
  }),

  body: z.object({
    eventType: z
      .string()
      .min(1, 'eventType is required')
      .max(255, 'eventType must be 255 characters or fewer'),
    payload: z.record(z.string(), z.unknown()),
  }),
});

module.exports = {
  createEventSchema,
};