# Webhook Delivery Service

Ingests events and delivers them to subscriber endpoints over signed HTTP, with
retries, backoff, and dead-letter handling. It's the same job Stripe does when
it POSTs an event to your endpoint.

The whole problem is that the receiver is out of our control — it can be down,
slow, or broken — so most of the code here is about delivering reliably anyway
rather than about the HTTP call itself.

## How it works

`POST /events` writes the event and one `Delivery` row per subscribed endpoint,
in a single transaction. Workers poll the `deliveries` table, claim due rows,
sign and POST them, and record what happened. There's no separate message
broker — the deliveries table is the queue, with `status` and `nextRetryAt`
driving the lifecycle.

```
POST /events -> API -> Postgres (deliveries = queue) -> worker xN -> subscriber
```

A delivery moves `PENDING -> DELIVERING -> DELIVERED`, or `-> FAILED` once it
either exhausts its retry budget or hits a terminal error. Failed deliveries can
be listed and redriven.

Code is organised as `routes -> controllers -> services -> repositories`. The
services don't know about HTTP, which is why the worker and the `deliver:once`
script reuse the same delivery logic the API uses.

## Stack

Node 22 (CommonJS), Express 5, Postgres 16, Prisma 6, Zod 4, Pino, Jest +
Supertest, Docker Compose.

## Running it

```bash
cp .env.example .env
docker compose up -d          # Postgres, migrations, API, 2 workers, receiver
```

Register the example receiver and send an event:

```bash
# use http://receiver:4000 if the API runs inside compose,
# http://localhost:4000 if you run the API on the host with `npm run dev`
curl -s -X POST localhost:3000/endpoints -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:4000/webhook","eventTypes":["payment.succeeded"]}'

# put the returned signingSecret in .env as RECEIVER_SECRET, then recreate it:
docker compose up -d --force-recreate receiver

curl -s -X POST localhost:3000/events \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"eventType":"payment.succeeded","payload":{"amount":2000}}'

docker compose logs -f receiver
```

To run the app on the host with only Postgres in Docker:

```bash
npm install
docker compose up -d postgres
npm run prisma:migrate
npm run dev        # API
npm run worker     # worker, separate terminal
```

## Endpoints

- `POST /endpoints` — register a subscriber. Returns a `whsec_` signing secret,
  shown once.
- `POST /events` — ingest an event. Requires an `Idempotency-Key` header.
- `GET /deliveries?status=FAILED` — failed deliveries, filterable by
  `endpointId` and `failureReason`, cursor-paginated.
- `POST /deliveries/:id/redrive` — requeue one failed delivery.
- `POST /endpoints/:id/redrive` — requeue an endpoint's exhausted failures.
- `GET /health` — liveness plus a DB check.

## Signing

Each request carries `Webhook-Signature: t=<unix>,v1=<hmac>` and a `Webhook-Id`.
The signed string is `${timestamp}.${rawBody}`, HMAC-SHA256 with the endpoint's
secret. A subscriber verifies against the raw request body (not a re-serialised
copy), checks the timestamp is recent to block replays, and compares in constant
time. `receiver/index.js` is a working reference implementation.

## Configuration

Config is read from the environment and validated at startup, so a bad value
fails the boot instead of surfacing later. `.env.example` lists everything; the
knobs that matter most are `MAX_DELIVERY_ATTEMPTS`, `BACKOFF_BASE_MS`,
`BACKOFF_CAP_MS`, `VISIBILITY_TIMEOUT_SECONDS`, and `WEBHOOK_TIMEOUT_MS`.

## Tests

```bash
createdb webhook_test
TEST_DATABASE_URL="postgresql://webhook:webhook@localhost:5432/webhook_test?schema=public" npm test
```

The integration tests run against a real Postgres rather than a mock, because
the parts most likely to break are in SQL — the `SKIP LOCKED` claim, the cursor
comparison, and the redrive queries. They cover idempotent ingestion, signature
verification, backoff, and redrive.

## Notes and limitations

- Delivery is at-least-once, not exactly-once. When a worker dies mid-delivery
  the reaper can't tell whether the request already reached the subscriber, so
  it re-delivers. Subscribers should dedupe on the event `id`.
- The service makes outbound requests to user-supplied URLs, so it's an SSRF
  target. It enforces https in production and doesn't follow redirects; it does
  not yet block private IP ranges after DNS resolution or restrict egress at the
  network level. See the notes in `src/validators/endpoint.validator.js`.
- The fan-out query filters on array membership, which can't use a plain B-tree
  index. At scale it needs a GIN index on `endpoints.eventTypes`.
- Postgres-as-a-queue is fine for typical web throughput. A dedicated broker
  only becomes worth it at very high sustained rates or for fan-out patterns
  this isn't built for.

`docs/FAILURE_MODES.md` goes through the specific failures and how each is
handled.