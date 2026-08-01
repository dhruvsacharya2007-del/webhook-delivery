const { z } = require('zod');


const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('warn'),

  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  
  VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),

  REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(30000),

 
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(5000),
  BACKOFF_FACTOR: z.coerce.number().positive().default(2),
  BACKOFF_CAP_MS: z.coerce.number().int().positive().default(3600000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  WORKER_IDLE_POLL_MS: z.coerce.number().int().positive().default(1000),  

  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(6),

  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(2),

  METRICS_PORT: z.coerce.number().int().positive().default(9091),

 
  ALLOW_HTTP_WEBHOOKS: z.coerce.boolean().default(false),
  SSRF_ALLOW_LOOPBACK: z.coerce.boolean().default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsed.data;