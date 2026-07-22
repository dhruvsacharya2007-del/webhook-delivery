
/**
 * Exponential backoff with EQUAL JITTER.
 *
 *   exponential = base × factor^(attempt - 1)
 *   capped      = min(exponential, cap)
 *   delay       = capped/2 + random(0, capped/2)
 *
 
 */
function computeBackoffDelayMs({
  attemptNumber,
  baseMs,
  factor,
  capMs,
  random = Math.random,
}) {
  const attempt = Math.max(1, Math.floor(attemptNumber));

  
  const exponent = Math.min(attempt - 1, 32);
  const exponential = baseMs * Math.pow(factor, exponent);

  const capped = Math.min(exponential, capMs);
  const half = capped / 2;

  return Math.round(half + random() * half);
}

function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue === null || headerValue === undefined) return null;

  const raw = String(headerValue).trim();
  if (raw === '') return null;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }


  const parsedDate = Date.parse(raw);
  if (Number.isNaN(parsedDate)) return null;

  return Math.max(0, parsedDate - now);
}


function computeNextRetryAt({
  attemptNumber,
  baseMs,
  factor,
  capMs,
  retryAfterHeader = null,
  now = Date.now(),
  random = Math.random,
}) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);

  if (retryAfterMs !== null) {
    const clamped = Math.min(retryAfterMs, capMs);
    return {
      nextRetryAt: new Date(now + clamped),
      delayMs: clamped,
      source: 'retry-after',
    };
  }

  const delayMs = computeBackoffDelayMs({ attemptNumber, baseMs, factor, capMs, random });

  return {
    nextRetryAt: new Date(now + delayMs),
    delayMs,
    source: 'backoff',
  };
}

function hasExhaustedRetries(attemptNumber, maxAttempts) {
  return attemptNumber >= maxAttempts;
}

module.exports = {
  computeBackoffDelayMs,
  parseRetryAfterMs,
  computeNextRetryAt,
  hasExhaustedRetries,
};