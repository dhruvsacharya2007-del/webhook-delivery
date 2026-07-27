const { AsyncLocalStorage } = require('node:async_hooks');
const pino = require('pino');
const env = require('../config/env');

const correlationStore = new AsyncLocalStorage();

const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  mixin() {
    const store = correlationStore.getStore();
    return store?.correlationId ? { correlationId: store.correlationId } : {};
  },
});

module.exports = logger;
module.exports.correlationStore = correlationStore;