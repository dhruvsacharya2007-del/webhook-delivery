const client = require('prom-client');

const register = new client.Registry();


client.collectDefaultMetrics({ register });

const deliveriesTotal = new client.Counter({
  name: 'deliveries_total',
  help: 'Webhook delivery attempts by outcome (per-attempt).',
  labelNames: ['outcome'],
  registers: [register],
});

const deliveryDuration = new client.Histogram({
  name: 'delivery_duration_seconds',
  help: 'Webhook delivery attempt duration in seconds, by outcome.',
  labelNames: ['outcome'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 11],
  registers: [register],
});

module.exports = { register, deliveriesTotal, deliveryDuration };