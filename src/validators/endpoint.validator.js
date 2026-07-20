const { z } = require('zod');
const env = require('../config/env');


const ALLOWED_PROTOCOL =
  env.NODE_ENV === 'production' ? /^https$/ : /^https?$/;


const createEndpointSchema = z.object({
  body: z.object({
    url: z.url({
      protocol: ALLOWED_PROTOCOL,
      error:
        env.NODE_ENV === 'production'
          ? 'Must be a valid https:// URL'
          : 'Must be a valid http:// or https:// URL',
    }),

    eventTypes: z
      .array(z.string().min(1, 'Event type cannot be empty'))
      .min(1, 'At least one event type is required'),
  }),
});

module.exports = {
  createEndpointSchema,
};