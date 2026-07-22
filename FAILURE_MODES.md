# Failure modes

Notes on what breaks and how the system responds. Roughly the order we hit these
while building it.

## Receiver is temporarily down

A 5xx, a timeout, or a connection error is treated as retryable. The delivery
goes back to `PENDING` with `nextRetryAt = now + backoff`, where backoff is
`min(base * 2^attempt, cap)` with jitter applied. After `MAX_DELIVERY_ATTEMPTS`
it's dead-lettered with reason `RETRIES_EXHAUSTED`.

The jitter matters more than it looks. Without it, every delivery that failed in
the same incident retries at the same instant, so a recovering server gets hit
by a synchronised spike and falls over again. Spreading the retries out breaks
that pattern. We use equal jitter (`d/2 + random(0, d/2)`) rather than full
jitter so there's always at least some delay before the next attempt.

## Receiver rejects us

A 400, 401, or 410 is terminal — the request is wrong, or the endpoint is gone,
and sending the identical request again won't change the answer. These are
dead-lettered immediately as `ENDPOINT_REJECTED`. That reason is excluded from
bulk redrive, because replaying them just produces the same failure; someone has
to fix the secret or the endpoint first.

429 and 408 are the exceptions among 4xx codes — they're explicitly transient,
so they're retryable, and a `Retry-After` header is honoured (clamped to the cap
so a bad header can't park a delivery indefinitely).

## Same event ingested twice

A client whose first `POST /events` timed out retries with the same
`Idempotency-Key`. The second insert hits the unique constraint on
`idempotencyKey` and fails with P2002; we catch it, compare the request
fingerprint, and either return the original event (200) or reject the reuse with
a different body (422).

The reason this is a unique constraint and not a `SELECT` then `INSERT`: two
duplicate requests arriving together would both pass the existence check and
both insert. The database has to be the thing that serialises them.

## Two workers claim the same delivery

The claim is `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.
`FOR UPDATE` locks the selected rows; `SKIP LOCKED` tells a second worker to
skip rows another worker already holds instead of blocking on them. Each worker
ends up with a disjoint set and nobody waits.

Plain `FOR UPDATE` without `SKIP LOCKED` is still correct — no two workers get
the same row — but the second worker blocks until the first commits, which turns
concurrent workers into a queue. In testing that was around 1.3s of blocking
versus ~50ms with `SKIP LOCKED`.

## Worker crashes mid-delivery

A worker claims a delivery (sets it `DELIVERING`), sends the request, and is
killed before recording the result. The row is now stuck in `DELIVERING`, and
the claim query only looks at `PENDING`, so no worker will pick it up again.

Each worker runs a reaper that resets rows stuck in `DELIVERING` past the
visibility timeout (`claimedAt < now - VISIBILITY_TIMEOUT_SECONDS`) back to
`PENDING`. It increments `attemptCount` when it does — otherwise a delivery that
reliably crashes whatever worker picks it up would be resurrected forever and
take down worker after worker. Counting the reap means the retry budget
eventually gives up on it.

This is also where exactly-once delivery stops being possible. The reaper can't
tell "crashed before sending" from "crashed after the send succeeded but before
recording it", so it re-delivers, and the subscriber may see the event twice.
That's why delivery is at-least-once and subscribers are expected to dedupe on
the event id.

## Holding a transaction open during the HTTP call

This is the shape we deliberately avoided. If the claim transaction stays open
while the worker waits on the subscriber's server, a pooled connection is tied
up for the full timeout and the vacuum horizon is held back, so one slow
subscriber degrades the database for everyone. Instead the worker claims and
commits in milliseconds, then does the HTTP call. The tradeoff is that a crash
can now strand a row (see above), which is what the reaper cleans up.

## Event exists but was never delivered

The trap: insert the event, then crash before writing its delivery rows. Now
there's an event that's recorded as having happened but goes to nobody, with
nothing to signal it. We avoid it by writing the event and its delivery rows in
one transaction — either all of it commits or none does.

## Subscriber recovers and wants its backlog

An endpoint was down long enough to dead-letter a pile of deliveries as
`RETRIES_EXHAUSTED`. Once it's fixed, `POST /endpoints/:id/redrive` resets those
rows to the initial queue state (`PENDING`, `attemptCount` 0, `nextRetryAt` now,
`failureReason` cleared). It skips `ENDPOINT_REJECTED` rows, and it's guarded on
`status = 'FAILED'`, so redriving something that's already been requeued is a
harmless no-op rather than a way to reset the attempt count on an in-flight
delivery.

## What the system guarantees

At-least-once delivery, with deduplication left to the consumer. It won't lose an
event (the fan-out is transactional), won't deliver a row two workers hold, won't
retry forever, and won't strand work when a worker dies. It can't guarantee a
subscriber sees each event exactly once — nothing can, over an unreliable
network — which is why the event id is there for the consumer to dedupe on.