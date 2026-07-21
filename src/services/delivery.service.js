const prisma = require('../lib/prisma');
const env = require('../config/env');
const logger = require('../lib/logger');
const { sign } = require('../lib/signature');
const deliveryRepository = require('../repositories/delivery.repository');


const MAX_STORED_RESPONSE_CHARS = 500;

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
  // 3xx lands here: we do not follow redirects (SSRF), so a redirect is a
  // misconfigured endpoint, not a transient failure.
  return OUTCOME.TERMINAL;
}

/**
 * Perform one signed HTTP POST. No database access, no retry policy — just the
 * network call and what came back. Kept separate so it is testable on its own.
 *
 * @returns {{ statusCode: number|null, error: string|null, durationMs: number, responseBody: string|null }}
 */
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
    };
  }
}


function buildStatusTransition(outcome) {
  if (outcome === OUTCOME.SUCCESS) {
    return { status: 'DELIVERED', claimedAt: null };
  }

  if (outcome === OUTCOME.TERMINAL) {
    // A 400 or 401 will not fix itself; retrying is pure waste. Day 5 builds
    // the dead-letter tooling around this state.
    return { status: 'FAILED', claimedAt: null };
  }

  // RETRYABLE: make it eligible again immediately. Day 4 delays this.
  return { status: 'PENDING', claimedAt: null, nextRetryAt: new Date() };
}

/**
 * Attempt one delivery: load it, sign it, send it, record what happened.
 *
 * Classifies the outcome but does NOT schedule retries — when to try again and
 * when to give up is policy, and policy is Day 4. This function reports facts.
 *
 * @param {string} deliveryId
 * @returns {Promise<{ outcome: string, statusCode: number|null, error: string|null, durationMs: number, attemptNumber: number }>}
 */
async function attemptDelivery(deliveryId) {
  const delivery = await deliveryRepository.findByIdWithRelations(deliveryId);

  if (!delivery) {
    throw new Error(`Delivery not found: ${deliveryId}`);
  }

  if (delivery.status === 'DELIVERED') {
    logger.warn({ deliveryId }, 'Delivery already succeeded, skipping');
    return { outcome: OUTCOME.SUCCESS, statusCode: null, error: null, durationMs: 0, attemptNumber: delivery.attemptCount };
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

  // Record the attempt and move the delivery's status together. Recording an
  // attempt without updating the delivery (or vice versa) would leave the two
  // disagreeing about what happened.
  await prisma.$transaction(async (tx) => {
    await deliveryRepository.recordAttempt(
      {
        deliveryId: delivery.id,
        attemptNumber,
        statusCode: result.statusCode,
        error: result.error ?? (outcome === OUTCOME.SUCCESS ? null : `HTTP ${result.statusCode}`),
        durationMs: result.durationMs,
      },
      tx,
    );

    await deliveryRepository.updateStatus(
      delivery.id,
      {
        attemptCount: attemptNumber,
        ...buildStatusTransition(outcome),
      },
      tx,
    );
  });

  logger[outcome === OUTCOME.SUCCESS ? 'info' : 'warn'](
    {
      deliveryId,
      attemptNumber,
      outcome,
      statusCode: result.statusCode,
      durationMs: result.durationMs,
      error: result.error,
    },
    'Delivery attempt finished',
  );

  return {
    outcome,
    statusCode: result.statusCode,
    error: result.error,
    durationMs: result.durationMs,
    attemptNumber,
  };
}

module.exports = {
  attemptDelivery,
  sendSignedRequest,
  buildEnvelope,
  classifyStatus,
  OUTCOME,
};