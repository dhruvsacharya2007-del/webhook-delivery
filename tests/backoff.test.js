require('./setup-env');

const app = require('../src/app');


const { computeBackoffDelayMs, computeNextRetryAt, hasExhaustedRetries } = require('../src/lib/backoff');


describe('exponential backoff', () => {
  const P = { baseMs: 1000, factor: 2, capMs: 60000 };

  test('delay grows with each attempt (equal jitter lower bound doubles)', () => {
    const d = (n) => computeBackoffDelayMs({ ...P, attemptNumber: n, random: () => 0 });
    expect(d(1)).toBe(500);   
    expect(d(2)).toBe(1000);  
    expect(d(3)).toBe(2000);  
    expect(d(2)).toBeLessThan(d(4));
  });

  test('delay never exceeds the cap', () => {
    const d = computeBackoffDelayMs({ ...P, attemptNumber: 50, random: () => 1 });
    expect(d).toBeLessThanOrEqual(P.capMs);
  });

  test('equal jitter stays within [d/2, d]', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffDelayMs({ ...P, attemptNumber: 3 });
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });

  test('Retry-After overrides backoff but is clamped to the cap', () => {
    const now = 1_800_000_000_000;
    const obeyed = computeNextRetryAt({ ...P, attemptNumber: 2, retryAfterHeader: '30', now });
    expect(obeyed.source).toBe('retry-after');
    expect(obeyed.delayMs).toBe(30000);
    const hostile = computeNextRetryAt({ ...P, attemptNumber: 2, retryAfterHeader: '999999999', now });
    expect(hostile.delayMs).toBe(P.capMs); // clamped
  });

  test('the retry budget stops at the limit', () => {
    expect(hasExhaustedRetries(3, 4)).toBe(false);
    expect(hasExhaustedRetries(4, 4)).toBe(true);
  });
});