const { isBlockedIp } = require('../src/lib/ssrf');

describe('isBlockedIp', () => {
  // Always blocked regardless of the loopback flag.
  const alwaysBlocked = [
    '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
    '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1',
    '::ffff:169.254.169.254', 'not-an-ip',
  ];
  const alwaysAllowed = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'];

  describe.each([{ allowLoopback: false }, { allowLoopback: true }])('opts=%o', (opts) => {
    test.each(alwaysBlocked)('blocks %s', (ip) => expect(isBlockedIp(ip, opts)).toBe(true));
    test.each(alwaysAllowed)('allows %s', (ip) => expect(isBlockedIp(ip, opts)).toBe(false));
  });

  describe('loopback is flag-dependent', () => {
    const loopback = ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1'];
    test.each(loopback)('blocks %s when allowLoopback=false', (ip) =>
      expect(isBlockedIp(ip, { allowLoopback: false })).toBe(true));
    test.each(loopback)('allows %s when allowLoopback=true', (ip) =>
      expect(isBlockedIp(ip, { allowLoopback: true })).toBe(false));
  });
});