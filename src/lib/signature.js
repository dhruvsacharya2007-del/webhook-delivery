const crypto = require('node:crypto');

const SIGNATURE_VERSION = 'v1';


const DEFAULT_TOLERANCE_SECONDS = 300;

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function computeSignature({ rawBody, secret, timestamp }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}


function sign({ rawBody, secret, timestamp = currentUnixSeconds() }) {
  const signature = computeSignature({ rawBody, secret, timestamp });

  return {
    timestamp,
    signature,
    header: `t=${timestamp},${SIGNATURE_VERSION}=${signature}`,
  };
}


function parseSignatureHeader(header) {
  const result = { timestamp: null, signatures: [] };

  for (const segment of String(header).split(',')) {
    const separatorIndex = segment.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = segment.slice(0, separatorIndex).trim();
    const value = segment.slice(separatorIndex + 1).trim();

    if (key === 't') {
      result.timestamp = value;
    } else if (/^v\d+$/.test(key)) {
      result.signatures.push({ version: key, value });
    }
  }

  return result;
}

/*
Constant-time string comparison.
*/
 
function timingSafeCompare(a, b) {
  const bufferA = Buffer.from(String(a), 'utf8');
  const bufferB = Buffer.from(String(b), 'utf8');

  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Verify an incoming signed request.
 *
 * Returns a structured result rather than a boolean so the receiver can log
 * WHY verification failed — clock skew, rotated secret, and forgery are
 * different problems with different fixes.
 *
 * @returns {{ valid: boolean, reason?: string, timestamp?: number }}
 */
function verify({
  rawBody,
  secret,
  header,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = currentUnixSeconds(),
}) {
  if (!header) {
    return { valid: false, reason: 'missing_header' };
  }

  const parsed = parseSignatureHeader(header);

  if (!parsed.timestamp || parsed.signatures.length === 0) {
    return { valid: false, reason: 'malformed_header' };
  }

  const timestamp = Number(parsed.timestamp);
  if (!Number.isInteger(timestamp)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }

  
  const skewSeconds = Math.abs(now - timestamp);
  if (skewSeconds > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_out_of_tolerance', skewSeconds };
  }

  const expected = computeSignature({ rawBody, secret, timestamp });

  const matched = parsed.signatures.some(
    (candidate) =>
      candidate.version === SIGNATURE_VERSION &&
      timingSafeCompare(candidate.value, expected),
  );

  if (!matched) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  return { valid: true, timestamp };
}

module.exports = {
  sign,
  verify,
  computeSignature,
  parseSignatureHeader,
  timingSafeCompare,
  SIGNATURE_VERSION,
  DEFAULT_TOLERANCE_SECONDS,
};