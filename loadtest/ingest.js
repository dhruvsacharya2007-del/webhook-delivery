import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;

const created = new Counter('events_created');

export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 4000,                         // higher ceiling: at 1500/s with latency, more VUs needed
      stages: [
        { target: 200,  duration: '30s' },
        { target: 400,  duration: '30s' },
        { target: 600,  duration: '30s' },
        { target: 800,  duration: '30s' },
        { target: 1000, duration: '30s' },
        { target: 1200, duration: '30s' },
        { target: 1500, duration: '30s' },
        { target: 1500, duration: '45s' },   // hold at peak to test sustain
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const key = `${RUN_ID}-vu-${__VU}-iter-${__ITER}`;
  const res = http.post(
    `${BASE}/events`,
    JSON.stringify({ eventType: 'load.test', payload: { vu: __VU, iter: __ITER } }),
    { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } },
  );
  const ok = check(res, { 'status 201': (r) => r.status === 201 });
  if (ok) created.add(1);
}