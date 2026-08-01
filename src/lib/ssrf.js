const dns = require('node:dns');
const net = require('node:net');
// NOTE: no longer imports env — isBlockedIp is now a pure function.
const env = require('../config/env');

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
    if (a === 127) return !allowLoopback;              // loopback (flag-dependent)
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


function ssrfSafeLookup(hostname, options, callback) {
  const allowLoopback = env.SSRF_ALLOW_LOOPBACK === true;

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname, { allowLoopback })) {
      return callback(new SsrfError(`SSRF blocked: ${hostname}`));
    }
    if (options.all) {
      return callback(null, [{ address: hostname, family: net.isIP(hostname) }]);
    }
    return callback(null, hostname, net.isIP(hostname));
  }

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const safe = addresses.filter((a) => !isBlockedIp(a.address, { allowLoopback }));
    if (safe.length === 0) {
      return callback(new SsrfError(`SSRF blocked: ${hostname} resolved only to disallowed addresses`));
    }
    if (options.all) {
      return callback(null, safe);
    }
    callback(null, safe[0].address, safe[0].family);
  });
}

module.exports = { ssrfSafeLookup, isBlockedIp, SsrfError };