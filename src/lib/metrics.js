const client = require('prom-client');

const register = new client.Registry();


client.collectDefaultMetrics({ register });

const deliveriesTotal = new client.Counter({
  name: 'deliveries_total',
  help: 'Webhook delivery attempts by outcome (per-attempt).',
  labelNames: ['outcome'],
  registers: [register],
});

module.exports = { register, deliveriesTotal };