require('./setup-env');

const app = require('../src/app');

const { sign, verify } = require('../src/lib/signature');


describe('HMAC signing', () => {
  const secret = `whsec_${'a'.repeat(64)}`;
  const rawBody = JSON.stringify({ id: 'evt_1', data: { amount: 2000 } });
  const NOW = 1_800_000_000;

  test('a valid signature verifies', () => {
    const { header } = sign({ rawBody, secret, timestamp: NOW });
    expect(verify({ rawBody, secret, header, now: NOW }).valid).toBe(true);
  });

  test('a tampered body is rejected', () => {
    const { header } = sign({ rawBody, secret, timestamp: NOW });
    const tampered = rawBody.replace('2000', '9999');
    expect(verify({ rawBody: tampered, secret, header, now: NOW }).valid).toBe(false);
  });

  test('the wrong secret is rejected', () => {
    const { header } = sign({ rawBody, secret, timestamp: NOW });
    expect(verify({ rawBody, secret: `whsec_${'b'.repeat(64)}`, header, now: NOW }).valid).toBe(false);
  });

  test('a replay outside the tolerance window is rejected', () => {
    const { header } = sign({ rawBody, secret, timestamp: NOW });
    const res = verify({ rawBody, secret, header, now: NOW + 600 }); // 10 min later
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('timestamp_out_of_tolerance');
  });

  test('editing the timestamp to defeat the window fails the signature', () => {
    const { signature } = sign({ rawBody, secret, timestamp: NOW });
    const forged = `t=${NOW + 600},v1=${signature}`; // fresh t, old v1
    expect(verify({ rawBody, secret, header: forged, now: NOW + 600 }).valid).toBe(false);
  });
});