const { z } = require('zod');

const createEndpointSchema = z.object({
  body: z.object({
    url: z.url({
      protocol: /^https$/,
      error: 'Must be a valid https:// URL',
    }),

    eventTypes: z
      .array(z.string().min(1, 'Event type cannot be empty'))
      .min(1, 'At least one event type is required'),
  }),
});

module.exports = {
  createEndpointSchema,
};