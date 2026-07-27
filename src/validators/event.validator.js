const { z } = require('zod');


const createEventSchema = z.object({
  headers: z.object({
    
  'idempotency-key': z
    .string({ error: 'Idempotency-Key header is required' })
    .min(1, 'Idempotency-Key header is required')
    .max(255, 'Idempotency-Key must be 255 characters or fewer'),
  'x-request-id': z
    .string()
    .max(128, 'X-Request-Id must be 128 characters or fewer')
    .regex(/^[A-Za-z0-9_-]+$/, 'X-Request-Id may only contain letters, numbers, _ and -')
    .optional(),
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