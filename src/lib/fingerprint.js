const crypto = require('node:crypto');
const stableStringify = require('fast-json-stable-stringify');

/**
 * Deterministic fingerprint of a request's meaningful content.
 *
 * Plain SHA-256, not HMAC: we need DETERMINISM, not authenticity. The value
 * never leaves our database and is not a security boundary, so a key would add
 * management burden for no benefit.
 *
 * stableStringify sorts object keys recursively, so {a:1,b:2} and {b:2,a:1}
 * hash identically. Array order is preserved, because order IS semantic in
 * arrays even though key order is not in objects.
 *
 * eventType participates because the same payload under a different type is a
 * different event.
 *
 * Canonicalization note: the ':' delimiter is unambiguous only because payload
 * is validated as an object, so stableStringify(payload) always starts with
 * '{'. If that validation ever loosens, switch to length-prefixing.
 */
function generateRequestFingerprint({ eventType, payload }) {
  return crypto
    .createHash('sha256')
    .update(`${eventType}:${stableStringify(payload)}`)
    .digest('hex');
}

module.exports = { generateRequestFingerprint };