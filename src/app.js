const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const prisma = require('./lib/prisma');
const { errorHandler } = require('./middleware/errorHandler');
const endpointRoutes = require('./routes/endpoint.routes');
const eventRoutes = require('./routes/event.routes');

const app = express();

app.use(express.json());
app.use(pinoHttp({ logger }));

// Liveness + DB connectivity check. Confirms the app booted AND can reach Postgres.
app.get('/health', async (req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    next(err);
  }
});

// Feature routes. Mounted AFTER express.json() (they need a parsed body)
// and BEFORE errorHandler (which must be last to catch what they throw).
app.use('/endpoints', endpointRoutes);
app.use('/events' ,  eventRoutes);

app.use(errorHandler);

module.exports = app;