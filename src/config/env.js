const { z } = require('zod');

// Validate env at boot. If it's wrong, we crash immediately with a clear
// message instead of failing mysteriously deep in a request later.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // How long we wait for a subscriber to respond before aborting the request.
  // Long enough for a slow-but-alive receiver, short enough that one dead
  // endpoint cannot occupy a worker slot indefinitely.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsed.data;