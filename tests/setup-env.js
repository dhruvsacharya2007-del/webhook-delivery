
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://webhook:webhook@localhost:5432/webhook_test?schema=public';
process.env.WEBHOOK_TIMEOUT_MS = '2000';
process.env.BACKOFF_BASE_MS = '100';
process.env.BACKOFF_FACTOR = '2';
process.env.BACKOFF_CAP_MS = '5000';
process.env.MAX_DELIVERY_ATTEMPTS = '4';
process.env.VISIBILITY_TIMEOUT_SECONDS = '60';