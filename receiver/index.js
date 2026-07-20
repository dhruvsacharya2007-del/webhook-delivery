
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.WEBHOOK_SECRET || '';
const TOLERANCE_SECONDS = Number(process.env.TOLERANCE_SECONDS || 300);
const FLAKY_FAILURES = Number(process.env.FLAKY_FAILURES || 2);



function computeSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function parseSignatureHeader(header) {
  const out = { timestamp: null, signatures: [] };
  for (const segment of String(header).split(',')) {
    const i = segment.indexOf('=');
    if (i === -1) continue;
    const key = segment.slice(0, i).trim();
    const value = segment.slice(i + 1).trim();
    if (key === 't') out.timestamp = value;
    else if (/^v\d+$/.test(key)) out.signatures.push({ version: key, value });
  }
  return out;
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignature(rawBody, header) {
  if (!SECRET) return { valid: false, reason: 'no_secret_configured' };
  if (!header) return { valid: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(header);
  if (!parsed.timestamp || parsed.signatures.length === 0) {
    return { valid: false, reason: 'malformed_header' };
  }

  const timestamp = Number(parsed.timestamp);
  if (!Number.isInteger(timestamp)) return { valid: false, reason: 'invalid_timestamp' };

  
  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skew > TOLERANCE_SECONDS) {
    return { valid: false, reason: `timestamp_out_of_tolerance (${skew}s)` };
  }

  const expected = computeSignature(SECRET, timestamp, rawBody);
  const matched = parsed.signatures.some(
    (c) => c.version === 'v1' && timingSafeCompare(c.value, expected),
  );

  return matched ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

const processedEventIds = new Set();
const flakyAttempts = new Map();

function log(fields) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', secretConfigured: Boolean(SECRET) }));
  }

  if (req.method !== 'POST' || url.pathname !== '/webhook') {
    res.writeHead(404);
    return res.end();
  }

  // Collect the RAW bytes. There is no body parser here, so the original bytes
  // survive by default — which is precisely what signature verification needs.
  // An Express receiver using express.json() would have to work to keep these.
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const mode = url.searchParams.get('mode') || 'ok';
    const deliveryId = req.headers['webhook-id'] || null;

    const verification = verifySignature(rawBody, req.headers['webhook-signature']);

    let eventId = null;
    let eventType = null;
    try {
      const envelope = JSON.parse(rawBody);
      eventId = envelope.id;
      eventType = envelope.type;
    } catch {
      
    }

    const duplicate = eventId ? processedEventIds.has(eventId) : false;

    log({
      msg: 'webhook received',
      mode,
      deliveryId,
      eventId,
      eventType,
      signature: verification.valid ? 'VALID' : `INVALID (${verification.reason})`,
      duplicate,
    });

    // A real subscriber rejects unverified requests outright. We only warn when
    // no secret is configured, so the rig is usable before you paste one in.
    if (!verification.valid && verification.reason !== 'no_secret_configured') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: verification.reason }));
    }

    if (mode === 'timeout') return; // hang forever; sender must abort

    if (mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'simulated server error' }));
    }

    if (mode === 'reject') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'simulated permanent rejection' }));
    }

    if (mode === 'ratelimit') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      return res.end(JSON.stringify({ error: 'slow down' }));
    }

    if (mode === 'badsig') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'simulated signature rejection' }));
    }

    if (mode === 'flaky') {
      const key = eventId || deliveryId || 'unknown';
      const soFar = (flakyAttempts.get(key) || 0) + 1;
      flakyAttempts.set(key, soFar);

      if (soFar <= FLAKY_FAILURES) {
        log({ msg: 'flaky failing on purpose', key, attempt: soFar, willSucceedAfter: FLAKY_FAILURES });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `flaky failure ${soFar}/${FLAKY_FAILURES}` }));
      }
      log({ msg: 'flaky succeeding now', key, attempt: soFar });
    }

    if (eventId) processedEventIds.add(eventId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true, eventId, duplicate }));
  });
});

server.listen(PORT, () => {
  log({ msg: 'receiver listening', port: PORT, secretConfigured: Boolean(SECRET) });
  if (!SECRET) {
    log({ msg: 'WARNING: WEBHOOK_SECRET not set — signatures will not be verified' });
  }
});

// Graceful shutdown, same discipline as the main service.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log({ msg: 'shutting down', signal });
    server.close(() => process.exit(0));
  });
}