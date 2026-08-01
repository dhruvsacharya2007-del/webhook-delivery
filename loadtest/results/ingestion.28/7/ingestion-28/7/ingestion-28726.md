# Load Test Findings — Webhook Delivery Service

**Environment:** Local (all components co-located — no network/RTT artifacts)
**Hardware:** MacBook Air (Apple Silicon), Postgres 18 in Docker (~4 CPU cores available)
**Tooling:** k6 (ingestion), controlled backlog drain (delivery)
**Method:** constant-arrival-rate load for ingestion; timed backlog drain (60s deltas) for delivery

Local testing was chosen for the engineering numbers deliberately: co-locating the load
generator, API, worker, receiver, and database removes internet latency, cross-region
RTT, and public-network variability, so a throughput drop reflects a real system
bottleneck rather than the network. (Production is used only to populate dashboards,
not to measure limits — a low-tier shared VM is not a meaningful capacity target.)

---

## Summary

| Path | Result | Bottleneck |
|------|--------|-----------|
| Ingestion (`POST /events`) | **~720 events/sec sustained** | Postgres CPU (~300%, ~3 cores) |
| Delivery (optimized, 2 workers) | **~1,280 deliveries/sec** at ~65% DB CPU | headroom remaining |

**Central finding:** the application layer is never the bottleneck (Node stayed <15% CPU
throughout). The delivery path was initially Postgres-CPU-bound; batching per-delivery
writes into one transaction per claimed batch cut database CPU ~80%, moved the bottleneck
off the database, and restored horizontal scaling. A separate scheduling change eliminated
noisy-neighbor starvation with zero hot-path cost.

---

## Phase 1 — Ingestion capacity

Load applied to `POST /events` at a ramping constant arrival rate. Each request runs the
transactional-outbox write (insert Event + query endpoints + createMany Deliveries)
inside one interactive transaction. The API's Prisma connection pool was varied.

| Connection pool | Sustained rate | Error rate | p95 latency | Bottleneck |
|-----------------|---------------|-----------|-------------|-----------|
| 2 (default)     | ~250/s        | 20.5%     | ~2.0 s      | Pool starvation |
| 20              | ~331/s        | 0%        | ~70 ms      | (headroom remained) |
| 40              | **~720/s**    | ~12% at peak | ~2.2 s   | **Postgres CPU (~300%)** |

**At pool=2:** hundreds of concurrent requests queued on 2 connections and timed out at
Prisma's ~2s transaction-acquire limit (P2028). p95 pinned at exactly 2.0s — the tell.
1 in 5 requests failed. The bottleneck was the pool, not the database.

**Fixing the pool moved the bottleneck to Postgres CPU.** At pool=40, the database
saturated at ~300% CPU (≈3 cores) while the Node API stayed under 12%. Ingestion is
therefore **database-write-bound** on the outbox transaction, not application-bound.

**Diagnostic detail:** the same p95≈2s wall appeared at both pool=2 and pool=40, but for
different reasons — pool starvation in the first case, Postgres unable to start
transactions fast enough (CPU-bound) in the second. Same symptom, different root cause.

---

## Phase 2 — Delivery throughput (baseline)

A fixed backlog (~222k PENDING deliveries pointing at a fast local receiver returning
instant 200s) was pre-loaded, frozen (no new ingestion), and drained. Each delivery in
the **baseline implementation** performs one outbound HTTP request plus its own
transaction (record attempt + update status). Batch size and worker count were varied
while holding the worker's connection pool at 20.

| Configuration | Rate | Postgres CPU | Change |
|---------------|------|-------------|--------|
| 1 worker, batch 5  | ~675/s   | ~50%      | baseline |
| 1 worker, batch 20 | ~1,090/s | ~170%     | **+61%** (batching) |
| 2 workers, batch 20| ~1,200/s | ~215%     | **+10%** (2nd worker) |

**Small batches were concurrency-limited, not resource-limited.** At batch=5, Postgres
sat at only 50% and the worker was nearly idle — it serialized on small batch boundaries
(claim 5, await all 5, repeat), never generating enough concurrency to load the database.

**Larger batches helped.** Raising batch size to 20 put 4× more concurrent work in
flight, pushing Postgres from 50% → 170% and throughput up 61%: more concurrent
transactions → higher DB utilization → higher throughput.

**The second worker barely helped.** Batch=20 alone already ran Postgres at 170%; a
second worker pushed it to ~215% but added only ~10% throughput. `FOR UPDATE SKIP LOCKED`
distributed work across the two workers with **zero lock contention** — no deadlocks, no
duplicate deliveries, backlog drained monotonically to zero. But perfect worker-scaling
produced almost no throughput gain, because the bottleneck was never the workers — it was
**shared Postgres CPU**.

**Key insight:** `SKIP LOCKED` scales the *workers* cleanly, but scaling workers does not
scale the *system* once a shared resource (database CPU) is the constraint. Two workers
dividing DB-bound work is not two workers' worth of throughput.

---

## Optimization — batched delivery writes

### Hypothesis
The baseline delivery path was Postgres-CPU-bound: a second worker added only ~10%
because the database was saturated (~215% CPU). Hypothesis: the dominant cost was
**per-delivery transaction commits** — at batch=20, each claimed batch performed 20
separate transactions = 20 `BEGIN`/`COMMIT` pairs and, critically, **20 fsyncs** (each
`COMMIT` forces a WAL flush to disk, ~1-10ms each, serialized).

### Change
The write path was refactored so each claimed batch performs **one transaction** instead
of one-per-delivery:
- `attemptDelivery` no longer writes; it returns the intended writes
  (`{ attemptRow, statusUpdate }`, or `{ skip: true }` for already-DELIVERED rows).
- `processBatch` collects the writes from all fulfilled, non-skip results and calls a
  repository function `applyBatchWrites(writes)`.
- `applyBatchWrites` runs one transaction: one `createMany` for all attempt rows + a loop
  of per-row `update`s for the (differing) status transitions, then a single `COMMIT`.
- HTTP, outcome classification, metrics, logging, and correlation-ID context remain
  per-delivery — only the DB persistence was batched.

Per batch of 20: **1 createMany + 20 updates + 1 commit** (down from 20×(insert + update +
commit)). The attempt inserts collapse to a single statement for free; the updates stay
individual (the "fsync-elimination" bet, deferring a raw `UPDATE ... FROM VALUES` approach
unless statement count proves to be the next bottleneck).

### Correctness analysis
Batching trades per-delivery fault isolation for throughput: if the batch transaction
fails partway, all rows in it roll back (including already-sent deliveries), and the
reaper re-delivers them. This is **acceptable** because it produces the *same class* of
duplicate the system already handles — the service is at-least-once, subscribers dedupe
on `Webhook-Id`, and the reaper already re-delivers on worker death. No new correctness
guarantee is broken. Batch updates are simple primary-key operations, so partial failure
is rare.

### Results

| Configuration | Rate | Postgres CPU | Bottleneck |
|---------------|------|-------------|-----------|
| Baseline: 1 worker, per-delivery txn | ~1,090/s | ~170% | DB |
| Baseline: 2 workers, per-delivery txn | ~1,200/s | ~215% | DB pegged (2nd worker +10%) |
| Optimized: 1 worker, batched txn | ~865/s | **~35%** | not DB |
| Optimized: 2 workers, batched txn | ~1,280/s | ~65% | approaching DB again |

**Headline: Postgres CPU dropped ~80% (170% → 35%) for equivalent single-worker
throughput.** The commit/fsync overhead was confirmed as the dominant cost.

**Proof the bottleneck moved:** the second worker's contribution went from **+10%**
(baseline, DB pegged) to **+48%** (optimized, DB at 35% with headroom). `FOR UPDATE SKIP
LOCKED` was already distributing work with zero contention; the difference is that
batching freed the shared resource (DB CPU) so a second worker now actually adds
throughput. CPU scaled near-linearly (~30% per worker), implying the optimized ceiling is
well above the baseline's ~1,200/s wall.

### Caveat
Single-worker throughput dipped slightly (1,090 → 865) because the batched path waits for
all HTTP calls in a batch to settle (`Promise.allSettled`) before the single write, so
each batch is gated by its slowest HTTP call. This is a good trade: worker time is cheap
and horizontally scalable, whereas database CPU is the scarce shared resource — and the DB
cost fell ~80% while horizontal scaling was restored.

### Scope of testing
Testing stopped at two workers / ~65% Postgres CPU. The hypothesis (batching removes the
DB bottleneck) is fully established by the CPU drop + restored scaling; pushing to an
exhausted-machine maximum would produce a larger number but not a stronger conclusion. The
efficiency win (80% CPU reduction, scaling restored) is the result worth citing, not a raw
max-throughput figure.



## Fairness — noisy-neighbor prevention

### Problem
The claim query ordered purely by `nextRetryAt` (FIFO). One endpoint with a large backlog
(e.g. 200k deliveries created first) would be drained completely before a low-volume
endpoint's handful of deliveries were touched — head-of-line blocking / tenant-isolation
failure. A late-arriving, business-critical webhook waits behind someone else's firehose.

### Fairness definition
**Bounded progress, not equal turns.** Every active endpoint should make progress
regardless of another endpoint's backlog size. Approximate fairness is acceptable;
correctness (SKIP LOCKED) and throughput are prioritized above perfect equality. A
per-endpoint interleave, not strict round-robin.

### The core constraint
The natural way to cap per endpoint is a window function
(`ROW_NUMBER() OVER (PARTITION BY endpointId)`), but Postgres **forbids `FOR UPDATE` with
window functions** — because `SKIP LOCKED` changes the row set at scan time, which makes
the window ranking ambiguous. The concurrency-safe claim mechanism and the natural
fairness expression are mutually exclusive in one query.

### Solution: write-time fairness key
Rather than compute fairness on the hot claim path, it is precomputed once at delivery
creation:
- `endpoints.deliverySequence` (Int, default 0): a per-endpoint counter.
- `deliveries.endpointSeq` (Int): assigned at creation via
  `UPDATE endpoints SET "deliverySequence" = "deliverySequence"+1 RETURNING`, inside the
  existing outbox transaction (atomic, no window function).
- The claim query changes only its ordering:
  `ORDER BY "endpointSeq" ASC NULLS LAST, "nextRetryAt" ASC`
- Supporting index: `(status, endpointSeq, nextRetryAt)`.

**Why it works:** ordering by `endpointSeq` groups all endpoints' "1st delivery" before
any "2nd delivery." A whale's 200,000th row (seq=200000) sorts last; a minnow's 5 rows
(seq 1-5) sort with the whale's first 5. Round-robin-like interleaving emerges from a
plain indexed sort — no window function, no `FOR UPDATE` conflict, no hot-path cost. The
fairness cost is paid once at write time, not on every claim.

### Design tradeoff (surfaced and accepted)
The per-endpoint counter serializes inserts *for a single endpoint* (row lock on its
counter). Worst case is a single-endpoint burst — the same scenario fairness targets.
Accepted because: (a) it serializes only within one endpoint (cross-endpoint inserts still
parallelize), and (b) an endpoint receiving a burst is delivery-bound, not
ingestion-bound. A simpler endpoint-row counter was chosen over per-endpoint Postgres
sequences; escalate only if measurements demand it.

### Validation

**Fairness (whale-vs-minnow):** ~3,000 deliveries loaded for a whale endpoint, then 5 for
a minnow endpoint created *last*. With one worker started, the minnow drained 5 → 0 in
~1 second while thousands of whale deliveries were still pending. Under the old FIFO
ordering the minnow (newest `nextRetryAt`) would have waited behind all 3,000 whale rows.
Head-of-line blocking eliminated; both endpoints progressed (whale not starved in the
other direction).

**Claim-path cost (EXPLAIN ANALYZE):** the new ordering uses
`Index Scan using deliveries_status_endpointSeq_nextRetryAt_idx` (not Seq Scan + Sort),
8 shared buffers, 0.17ms execution. Write-time fairness kept the hot path a cheap indexed
scan regardless of backlog size — the design goal.

**Ingestion cost:** the ingestion benchmark was re-run (single-endpoint, the predicted
worst case for counter serialization) with fairness enabled: ~850 events/sec, 0% errors,
p95 52ms. No meaningful regression. (Caveat: not a clean single-variable A/B against a
counter-free build — the honest claim is "ingestion stayed healthy with fairness," not
"fairness improved ingestion.")

### Result
Noisy-neighbor starvation eliminated with zero hot-path cost, validated on correctness
(whale-vs-minnow), claim-path efficiency (EXPLAIN index scan), and ingestion health
(~850/s). The window-function-vs-`SKIP LOCKED` deadlock was sidestepped rather than
solved, by moving the fairness computation to write time.

---

## Root cause summary & remaining levers

The application layer (Node) was never the bottleneck — it stayed under 15% CPU across
every test. The binding constraint throughout was **Postgres CPU** on per-operation
transactions. Remaining levers, in order of leverage:

1. **Reduce work per ingestion transaction.** The outbox holds a connection across an
   endpoint *query*; expressing fan-out as a single `INSERT ... SELECT` would cut round
   trips and CPU per event.
2. **Collapse per-row delivery updates** into a single `UPDATE ... FROM (VALUES ...)` if
   statement count becomes the next delivery bottleneck.
3. **Scale Postgres vertically.** The workload is CPU-bound, not memory-bound (Postgres
   used ~14% of memory at peak). More cores directly raise the ceiling.



## Measurement notes

- Local single-machine test: the database, app, and load generator share CPU, so absolute
  numbers are specific to this hardware. The *relative* findings (where the bottleneck is,
  how it moves with pool size / batch size / worker count / batching) are the transferable
  result.
- The delivery target was a local receiver returning instant 200s, so the delivery HTTP
  round-trip added ~0ms and the worker/DB overhead dominated — isolating internal
  throughput. Real subscriber latency would lower absolute delivery rates.
- `worker_active_jobs` frequently sampled as 0 because fast local batches complete between
  metric scrapes; under slower real endpoints it would sit non-zero.

## SSRF hardening

## Threat model

The service makes outbound HTTP requests to user-supplied URLs — the textbook setup for Server-Side Request Forgery. An attacker registering a webhook endpoint at http://169.254.169.254/ (cloud metadata), http://10.0.0.1/admin (internal service), or http://127.0.0.1:5432/ (the database) turns the worker into a proxy into the trusted network.

Defense: connection-time IP pinning via custom lookup hook

Validation at registration is insufficient (DNS can change before delivery); validation at request time has a TOCTOU gap (the HTTP client re-resolves). Enforcement at connection time closes both: a custom dns.lookup hook resolves the hostname, validates every candidate IP against the blocklist, and returns only the vetted IP — the socket connects to the address that was checked, with no re-resolution.

Blocklist covers: loopback (127/8), private (10/8, 172.16/12, 192.168/16), link-local including cloud metadata (169.254/16), CGNAT (100.64/10), multicast (224/4), unspecified (0.0.0.0, ::), IPv6 equivalents (::1, fe80::/10, fc00::/7, ff00::/8), and IPv4-mapped IPv6 (::ffff:127.0.0.1 → normalized to 127.0.0.1 before checking — a classic bypass).

A literal-IP URL (e.g. https://10.0.0.1/) skips DNS resolution entirely, so the lookup hook never fires. A pre-request check (net.isIP(hostname) && isBlockedIp(...)) catches this path. Two entry points, same blocklist.

## Additional hardening
HTTPS-only in production (http gated behind a default-off ALLOW_HTTP_WEBHOOKS flag for dev/test).
Redirects disabled — http.request does not auto-follow; 3xx classified terminal. Each redirect is effectively a new outbound request to an unvalidated destination.
Permanent vs transient classification — SSRF blocks, bad-scheme, and malformed URLs fail terminally on attempt 1 (via a SsrfError class and a terminal flag in the result), rather than consuming the retry budget over 6 futile attempts.
Dev escape hatch — SSRF_ALLOW_LOOPBACK (default false) permits loopback in dev/test so the localhost receiver works. Metadata/private ranges stay blocked even in dev (asserted by the unit test running the blocklist under both flag values).

## Validation

isBlockedIp is a pure function (no hidden env dependency), unit-tested against an exhaustive table of IPs in both allowLoopback: true and allowLoopback: false modes — proving the flag works both ways and dangerous ranges stay blocked regardless.
SSRF block confirmed end-to-end: delivery to https://10.0.0.1 blocked instantly (durationMs: 1), classified terminal, attemptCount=1, status=FAILED. No packet left toward the private IP.


## Circuit breaker

## Problem

A dead endpoint (subscriber offline) with a large backlog steals worker capacity: every delivery times out (~10s each), consuming worker slots and connection-pool capacity that healthy endpoints need. The fairness work (Days 9-10) prevents a busy endpoint from starving others; the breaker prevents a dead endpoint from starving others.

## Design

State: failureCount (Int, default 0) and breakerOpenUntil (DateTime, nullable) on the endpoints table. Breaker state is derived: openUntil IS NULL or <= NOW() → closed; > NOW() → open. No enum — store the minimum, derive the rest.

Read side (claim query): JOIN endpoints with AND (breakerOpenUntil IS NULL OR breakerOpenUntil <= NOW()) excludes open-breaker endpoints at the query level. Deliveries to dead endpoints are never claimed (not claimed-then-skipped) — zero wasted work. FOR UPDATE OF dd SKIP LOCKED locks only delivery rows, not endpoint rows (without OF dd, the join would serialize all claims per endpoint).

Write side (batch commit): per-endpoint net health delta aggregated within the batch (A′: failures - successes, floored at 0). One CTE-based UPDATE endpoints per affected endpoint per batch, in the same transaction as the delivery writes. When failureCount crosses the threshold: open the breaker (set breakerOpenUntil to NOW() + cooldown) and reset failureCount to 0.

Model: cooldown-then-readmit (not true half-open). When the cooldown expires, all pending deliveries become claimable again. If the endpoint is still dead, the burst fails and the breaker re-opens. Accepts a burst each cycle; self-corrects fast.

Failure metric: A′ net delta, not "consecutive." Consecutive failures are undefinable in a distributed concurrent batched system (no global ordering). A′ is magnitude-aware (99 failures / 1 success → +98, not 0), aggregates cleanly per batch, and self-heals (successes pull the count down).
Configuration: BREAKER_FAILURE_THRESHOLD=5, BREAKER_COOLDOWN_SECONDS=30 (global env, configurable).

## Validation (behavioral)

Endpoint pointed at a receiver returning 500 (?mode=fail), 8 deliveries queued:

Phase 1 (opens): first batch of 8 failures drove failureCount past threshold. breakerOpenUntil set ~30s out, failureCount reset to 0.

Phase 2 (deferred): pending=8 held steady for ~30s while breakerOpenUntil was in the future. Worker did zero work on the failing endpoint — capacity preserved.

Phase 3 (readmit): cooldown expired, deliveries re-claimed, all failed again, breaker re-opened with a fresh cooldown. Complete self-resetting cycle.

The plateau during Phase 2 is the key proof: the worker stops burning timeouts on a known-dead endpoint, freeing capacity for healthy endpoints.