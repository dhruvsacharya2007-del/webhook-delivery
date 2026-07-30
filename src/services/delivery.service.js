
const env = require('../config/env');
const logger = require('../lib/logger');
const { sign } = require('../lib/signature');
const { computeNextRetryAt, hasExhaustedRetries } = require('../lib/backoff');
const deliveryRepository = require('../repositories/delivery.repository');
const {encodeCursor , decodeCursor } = require('../validators/delivery.validator');
const MAX_STORED_RESPONSE_CHARS = 500;
const { AppError } = require('../middleware/errorHandler');
const { deliveriesTotal, deliveryDuration } = require('../lib/metrics');

const OUTCOME = {
  SUCCESS: 'success',
  RETRYABLE: 'retryable',
  TERMINAL: 'terminal',
};


function buildEnvelope(event) {
  return {
    id: event.id,
    type: event.eventType,
    createdAt: event.createdAt,
    data: event.payload,
  };
}

function classifyStatus(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return OUTCOME.SUCCESS;
  if (statusCode === 429 || statusCode === 408) return OUTCOME.RETRYABLE;
  if (statusCode >= 500) return OUTCOME.RETRYABLE;
  
  return OUTCOME.TERMINAL;
}


async function sendSignedRequest({ url, secret, envelope, deliveryId, timeoutMs }) {
  
  const rawBody = JSON.stringify(envelope);
  const { header } = sign({ rawBody, secret });

  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Webhook-Signature': header,
        'Webhook-Id': deliveryId,
        'User-Agent': 'webhook-delivery-service/1.0',
      },
      body: rawBody,
    
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

  
    const text = await response.text().catch(() => '');

    return {
      statusCode: response.status,
      error: null,
      durationMs: Date.now() - startedAt,
      responseBody: text.slice(0, MAX_STORED_RESPONSE_CHARS) || null,
      // A 429 usually carries Retry-After: the subscriber telling us exactly
      // when to come back. Ignoring it means walking straight back into the
      // same rate limit.
      retryAfterHeader: response.headers.get('retry-after'),
    };
  } catch (err) {
    
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';

    
    const cause = err.cause;
    const detail = cause?.code || cause?.message;

    return {
      statusCode: null,
      error: isTimeout
        ? `timeout after ${timeoutMs}ms`
        : `${err.name}: ${err.message}${detail ? ` (${detail})` : ''}`,
      durationMs: Date.now() - startedAt,
      responseBody: null,
      retryAfterHeader: null,
    };
  }
}


function buildStatusTransition({ outcome, attemptNumber, retryAfterHeader }) {
  if (outcome === OUTCOME.SUCCESS) {
    return { data: { status: 'DELIVERED', claimedAt: null }, scheduling: null };
  }

  if (outcome === OUTCOME.TERMINAL) {
    // A 400 or 401 will not fix itself; retrying is pure waste. This reason is
    // NOT redrivable — a human must fix the secret or the endpoint first.
    return {
      data: { status: 'FAILED', claimedAt: null, failureReason: 'ENDPOINT_REJECTED' },
      scheduling: null,
    };
  }

  if (hasExhaustedRetries(attemptNumber, env.MAX_DELIVERY_ATTEMPTS)) {
    return {
      data: { status: 'FAILED', claimedAt: null, failureReason: 'RETRIES_EXHAUSTED' },
      scheduling: { exhausted: true, maxAttempts: env.MAX_DELIVERY_ATTEMPTS },
    };
  }

  const schedule = computeNextRetryAt({
    attemptNumber,
    baseMs: env.BACKOFF_BASE_MS,
    factor: env.BACKOFF_FACTOR,
    capMs: env.BACKOFF_CAP_MS,
    retryAfterHeader,
  });

  return {
    data: { status: 'PENDING', claimedAt: null, nextRetryAt: schedule.nextRetryAt },
    scheduling: {
      exhausted: false,
      delayMs: schedule.delayMs,
      nextRetryAt: schedule.nextRetryAt,
      source: schedule.source,
    },
  };
}


async function attemptDelivery(deliveryId) {
  const delivery = await deliveryRepository.findByIdWithRelations(deliveryId);

  if (!delivery) {
    throw new Error(`Delivery not found: ${deliveryId}`);
  }

  
  return logger.correlationStore.run({ correlationId: delivery.correlationId }, () =>
    processAttempt(delivery, deliveryId),
  );
}

async function processAttempt(delivery, deliveryId) {
  if (delivery.status === 'DELIVERED') {
    logger.warn({ deliveryId }, 'Delivery already succeeded, skipping');
    return { skip: true, outcome: OUTCOME.SUCCESS };   
  }

  const attemptNumber = delivery.attemptCount + 1;
  const envelope = buildEnvelope(delivery.event);
  const result = await sendSignedRequest({
    url: delivery.endpoint.url,
    secret: delivery.endpoint.signingSecret,
    envelope,
    deliveryId: delivery.id,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
  });

  const outcome =
    result.statusCode === null ? OUTCOME.RETRYABLE : classifyStatus(result.statusCode);

  deliveriesTotal.inc({ outcome });                       
  deliveryDuration.observe({ outcome }, result.durationMs / 1000);  

  const transition = buildStatusTransition({ outcome, attemptNumber, retryAfterHeader: result.retryAfterHeader });

  // Per-delivery logging stays here (per-delivery fact, correct correlationId in scope)
  logger[outcome === OUTCOME.SUCCESS ? 'info' : 'warn'](
    { deliveryId, attemptNumber, outcome, statusCode: result.statusCode, durationMs: result.durationMs,
      error: result.error, nextStatus: transition.data.status,},
    'Delivery attempt finished',
  );

  
  return {
    skip: false,
    outcome,
    attemptRow: {
      deliveryId: delivery.id,
      attemptNumber,
      statusCode: result.statusCode,
      error: result.error ?? (outcome === OUTCOME.SUCCESS ? null : `HTTP ${result.statusCode}`),
      durationMs: result.durationMs,
    },
    statusUpdate: {
      id: delivery.id,
      data: { attemptCount: attemptNumber, ...transition.data },
    },
  };
}




async function listFailedDeliveries({ endpointId, failureReason, cursor, limit }) {
  const decoded = cursor ? decodeCursor(cursor) : null;
 
  const rows = await deliveryRepository.listFailed({
    endpointId,
    failureReason,
    cursorCreatedAt: decoded?.createdAt ?? null,
    cursorId: decoded?.id ?? null,
    limit: limit + 1, // one extra row reveals whether another page exists
  });
 
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
 
  const last = visible[visible.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
 
  return {
    data: visible.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      endpointId: row.endpointId,
      endpointUrl: row.endpointUrl,
      status: row.status,
      attemptCount: row.attemptCount,
      
      failureReason: row.failureReason ?? 'UNKNOWN',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    pagination: { nextCursor, hasMore },
  };
}
 
 
async function redriveDelivery(id) {
  const rows = await deliveryRepository.redriveOne(id);

  if (rows.length > 0) {
    logger.info({ deliveryId: id }, 'Delivery redriven');

    return {
      redriven: true,
      id,
    };
  }

  const delivery = await deliveryRepository.findById(id);

  if (!delivery) {
    throw new AppError(404, 'Delivery not found');
  }

  throw new AppError(
    409,
    'Delivery is not in the FAILED state and cannot be redriven',
  );
}

async function deliveryExists(id) {
  const delivery = await deliveryRepository.findByIdWithRelations(id);
  return delivery !== null;
}
 

async function redriveEndpointFailures(endpointId) {
  const rows = await deliveryRepository.redriveExhaustedForEndpoint(endpointId);
  const deliveryIds = rows.map((r) => r.id);
 
  logger.info(
    { endpointId, redrivenCount: deliveryIds.length },
    'Bulk redrive for endpoint',
  );
 
  return { redrivenCount: deliveryIds.length, deliveryIds };
}
 
module.exports = {
  attemptDelivery,
  sendSignedRequest,
  buildEnvelope,
  classifyStatus,
  listFailedDeliveries,
  redriveDelivery,
  redriveEndpointFailures,
  deliveryExists,
  OUTCOME,
};