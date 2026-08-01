const dns = require('node:dns');
const net = require('node:net');
// NOTE: no longer imports env — isBlockedIp is now a pure function.

class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
  }
}

// Pure function: loopback allowance is passed in, not read from env.
function isBlockedIp(ip, { allowLoopback = false } = {}) {
  const family = net.isIP(ip);
  if (family === 0) return true;

  let addr = ip;
  if (family === 6 && addr.toLowerCase().startsWith('::ffff:')) {
    const mapped = addr.slice(addr.lastIndexOf(':') + 1);
    if (net.isIP(mapped) === 4) addr = mapped;
  }

  if (net.isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 127) return !allowLoopback;               // loopback (flag-dependent)
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  const low = addr.toLowerCase();
  if (low === '::1') return !allowLoopback;             // loopback (flag-dependent)
  if (low === '::') return true;
  if (low.startsWith('fe80')) return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('ff')) return true;
  return false;
}


// dns.lookup-shaped hook. Resolves, validates the address it returns, and hands
// back exactly that vetted IP so the socket connects to THAT address with no
// re-resolution — closing the DNS-rebinding / TOCTOU gap. Throws SsrfError to abort.

const env = require('../config/env');

function ssrfSafeLookup(hostname, options, callback) {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) return callback(new SsrfError(`SSRF blocked: ${hostname}`));
    return callback(null, hostname, net.isIP(hostname));
  }

  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const safe = addresses.find((a) => !isBlockedIp(a.address));
    if (!safe) {
      return callback(new SsrfError(`SSRF blocked: ${hostname} resolved only to disallowed addresses`));
    }
    callback(null, safe.address, safe.family);
  });
}

module.exports = { ssrfSafeLookup, isBlockedIp, SsrfError };