const prisma = require('../lib/prisma');
const env = require('../config/env');
const logger = require('../lib/logger');
const { sign } = require('../lib/signature');
const deliveryRepository = require('../repositories/delivery.repository');

// How much of the subscriber's response body we keep for debugging. Their
// error page could be megabytes; we only need enough to diagnose.
const MAX_STORED_RESPONSE_CHARS = 500;

const OUTCOME = {
  SUCCESS: 'success',
  RETRYABLE: 'retryable',
  TERMINAL: 'terminal',
};

/**
 * Build the request body sent to subscribers.
 *
 * An envelope, not the bare payload: `id` gives the subscriber a stable key for
 * their own idempotency (the consumer side of at-least-once), and `type` lets
 * them route without inspecting the data.
 */
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

/**
 * Perform one signed HTTP POST. No database access, no retry policy — just the
 * network call and what came back. Kept separate so it is testable on its own.
 *
 * @returns {{ statusCode: number|null, error: string|null, durationMs: number, responseBody: string|null }}
 */
async function sendSignedRequest({ url, secret, envelope, deliveryId, timeoutMs }) {
  // Serialize ONCE and sign exactly these bytes. Serializing twice risks
  // signing different bytes than we send.
  const rawBody = JSON.stringify(envelope);
  const { header } = sign({ rawBody, secret });

  const startedAt = Date.now();

  console.log("POSTing to:", url);
  
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



async function attemptDelivery(deliveryId) {
  const delivery = await deliveryRepository.findByIdWithRelations(deliveryId);

  if (!delivery) {
    throw new Error(`Delivery not found: ${deliveryId}`);
  }
  console.log({
  deliveryId: delivery.id,
  endpointUrl: delivery.endpoint.url,
  endpointSecret: delivery.endpoint.signingSecret.slice(0, 12) + "...",
  eventId: delivery.event.id,
  });
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
        
        ...(outcome === OUTCOME.SUCCESS ? { status: 'DELIVERED' } : {}),
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