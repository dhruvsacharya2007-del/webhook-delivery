const logger = require('../lib/logger');

class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    logger.error({ err }, 'Unhandled error');
  } else {
    logger.warn({ err: err.message }, 'Operational error');
  }

  res.status(statusCode).json({
    error: {
      message: statusCode >= 500 ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

module.exports = { AppError, errorHandler };