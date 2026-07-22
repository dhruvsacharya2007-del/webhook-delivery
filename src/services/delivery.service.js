const prisma = require('../lib/prisma');
const env = require('../config/env');
const logger = require('../lib/logger');
const { sign } = require('../lib/signature');
const { computeNextRetryAt, hasExhaustedRetries } = require('../lib/backoff');
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
    // Network-level failure: DNS, connection refused, TLS, or our own abort.
    // No HTTP response exists, so statusCode stays null — which is exactly why
    // DeliveryAttempt.statusCode is nullable.
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';

    // undici wraps network failures as a generic "TypeError: fetch failed" and
    // puts the real reason (ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED) on
    // err.cause. Without unwrapping it, every network failure logs identically
    // and is undebuggable.
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
    // A 400 or 401 will not fix itself; retrying is pure waste.
    return { data: { status: 'FAILED', claimedAt: null }, scheduling: null };
  }

  // RETRYABLE, but out of budget: dead-letter it. Day 5 builds the tooling to
  // inspect and redrive rows in this state.
  if (hasExhaustedRetries(attemptNumber, env.MAX_DELIVERY_ATTEMPTS)) {
    return {
      data: { status: 'FAILED', claimedAt: null },
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

  
  const transition = buildStatusTransition({
    outcome,
    attemptNumber,
    retryAfterHeader: result.retryAfterHeader,
  });

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
        ...transition.data,
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
      nextStatus: transition.data.status,
      ...(transition.scheduling?.exhausted
        ? { retriesExhausted: true, maxAttempts: transition.scheduling.maxAttempts }
        : {}),
      ...(transition.scheduling && !transition.scheduling.exhausted
        ? {
            retryInMs: transition.scheduling.delayMs,
            nextRetryAt: transition.scheduling.nextRetryAt,
            scheduleSource: transition.scheduling.source,
          }
        : {}),
    },
    'Delivery attempt finished',
  );

  return {
    outcome,
    statusCode: result.statusCode,
    error: result.error,
    durationMs: result.durationMs,
    attemptNumber,
    nextStatus: transition.data.status,
    scheduling: transition.scheduling,
  };
}

module.exports = {
  attemptDelivery,
  sendSignedRequest,
  buildEnvelope,
  classifyStatus,
  OUTCOME,
};