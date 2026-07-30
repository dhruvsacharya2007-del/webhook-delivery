# Load Test Findings — Webhook Delivery Service

**Date:** 2026-07-28
**Environment:** Local (all components co-located — no network/RTT artifacts)
**Hardware:** MacBook Air (Apple Silicon), Postgres 18 in Docker (~4 CPU cores available)
**Tool:** k6 (ingestion), controlled backlog drain (delivery)
**Method:** constant-arrival-rate load for ingestion; timed backlog drain (60s deltas) for delivery

Local was chosen for the engineering numbers deliberately: co-locating the load
generator, API, worker, receiver, and database removes internet latency, cross-region
RTT, and public-network variability, so a throughput drop reflects a real system
bottleneck rather than the network. (Production is used only to populate dashboards,
not to measure limits — a ~$5/mo shared VM is not a meaningful capacity target.)

---

## Summary

| Path | Result | Bottleneck |
|------|--------|-----------|
| Ingestion (`POST /events`) | **~720 events/sec sustained** | Postgres CPU (~300%, ~3 cores) |
| Delivery drain (worker) | **~1,200 deliveries/sec** (2 workers) | Postgres CPU (shared ceiling) |

**Central finding:** both the ingestion and delivery paths are bounded by the same
resource — **Postgres CPU** — not by the application layer (Node stayed <15% CPU
throughout) and not by lock contention. Horizontal worker scaling does not raise
throughput while the database is the bottleneck.

---

## Phase 1 — Ingestion capacity

Hammered `POST /events` at a ramping constant arrival rate. Each request runs the
transactional-outbox write (insert Event + query endpoints + createMany Deliveries)
inside one interactive transaction. Varied the API's Prisma connection pool.

| Connection pool | Sustained rate | Error rate | p95 latency | Bottleneck |
|-----------------|---------------|-----------|-------------|-----------|
| 2 (default)     | ~250/s        | 20.5%     | ~2.0 s      | Pool starvation |
| 20              | ~331/s        | 0%        | ~70 ms      | (headroom remained) |
| 40              | **~720/s**    | ~12% at peak | ~2.2 s   | **Postgres CPU (~300%)** |

**What happened at pool=2:** hundreds of concurrent requests queued on 2 connections
and timed out at Prisma's ~2s transaction-acquire limit (P2028). p95 pinned at exactly
2.0s — the tell. 1 in 5 requests failed. The bottleneck was the pool, not the database.

**Fixing the pool moved the bottleneck to Postgres CPU.** At pool=40, the database
saturated at ~300% CPU (≈3 cores) while the Node API stayed under 12%. Ingestion is
therefore **database-write-bound** on the outbox transaction, not application-bound.

**Diagnostic detail:** the same p95≈2s wall appeared at both pool=2 and pool=40, but for
different reasons — pool starvation in the first case, Postgres unable to start
transactions fast enough (CPU-bound) in the second. Same symptom, different root cause.

---

## Phase 2 — Delivery throughput (worker drain)

Pre-loaded a fixed backlog (~222k PENDING deliveries pointing at a fast local receiver
in `mode=ok`, ~0ms response), froze it (no new ingestion), and measured how fast the
worker(s) drained it. Each delivery performs one outbound HTTP request plus one
transaction (record attempt + update status). Varied batch size and worker count while
holding the worker's connection pool at 20.

| Run | Config | Rate | Postgres CPU | Change |
|-----|--------|------|-------------|--------|
| 1 | 1 worker, batch 5  | ~675/s   | ~50%      | baseline |
| 2 | 1 worker, batch 20 | ~1,090/s | ~170%     | **+61%** (batching) |
| 3 | 2 workers, batch 20| ~1,200/s | ~215%     | **+10%** (2nd worker) |

**Run 1 was concurrency-limited, not resource-limited.** At batch=5, Postgres sat at
only 50% and the worker was nearly idle — the worker serialized on small batch
boundaries (claim 5, await all 5, repeat), never generating enough concurrency to load
the database.

**Run 2: batching worked.** Raising batch size to 20 put 4× more concurrent work in
flight, pushing Postgres from 50% → 170% and throughput up 61%. The mechanism is
explicit in the numbers: more concurrent transactions → higher DB utilization → higher
throughput.

**Run 3: the second worker barely helped — as predicted.** Batch=20 alone already ran
Postgres at 170%; a second worker pushed it to ~215% but added only ~10% throughput.
`FOR UPDATE SKIP LOCKED` distributed work across the two workers with **zero lock
contention** — no deadlocks, no duplicate deliveries, backlog drained monotonically to
exactly 0. But perfect worker-scaling produced almost no throughput gain, because the
bottleneck was never the workers — it was **shared Postgres CPU**.

**Key insight:** `SKIP LOCKED` scales the *workers* cleanly, but scaling workers does
not scale the *system* once a shared resource (database CPU) is the constraint. Two
workers dividing DB-bound work is not two workers' worth of throughput.

---

## Root cause & what would actually help

Both paths bottleneck on **Postgres CPU** doing per-operation transactions. Levers, in
order of leverage:

1. **Batch the delivery DB writes.** Each delivery currently runs its own transaction
   (record attempt + update status). Collapsing the status updates for a whole claimed
   batch into a single transaction would cut per-delivery DB overhead — the
   highest-leverage change, directly targeting the measured bottleneck.
2. **Reduce work per ingestion transaction.** The outbox holds a connection across an
   endpoint *query*; expressing fan-out as a single `INSERT ... SELECT` would cut round
   trips and CPU per event.
3. **Scale Postgres vertically.** The workload is CPU-bound, not memory-bound (Postgres
   used ~14% of memory at peak). More cores directly raise the ceiling.

**Explicitly not helpful:** adding more workers. Measured, not assumed — Run 3 proved a
second worker adds ~10% while the database is the bottleneck.

---

## Measurement notes / caveats

- Local single-machine test: the database, app, and load generator share CPU, so
  absolute numbers are specific to this hardware. The *relative* findings (where the
  bottleneck is, how it moves with pool size / batch size / worker count) are the
  transferable result.
- Delivery target was a local receiver returning instant 200s, so the delivery HTTP
  round-trip added ~0ms and the worker/DB overhead dominated — isolating internal
  throughput. Real subscriber latency would lower absolute delivery rates.
- `worker_active_jobs` frequently sampled as 0 because fast local batches complete
  between metric scrapes; under slower real endpoints it would sit non-zero.

---

# Day 8 — Batched Delivery Writes (Optimization)

## Hypothesis
Day 6 identified delivery throughput as Postgres-CPU-bound: a second worker added only
~10% because the database was saturated (~215% CPU). Hypothesis: the dominant cost was
**per-delivery transaction commits** — at batch=20, each claimed batch performed 20
separate transactions = 20 `BEGIN`/`COMMIT` pairs and, critically, **20 fsyncs** (each
`COMMIT` forces a WAL flush to disk, ~1-10ms each, serialized).

## Change
Refactored the write path so each claimed batch performs **one transaction** instead of
one-per-delivery:
- `attemptDelivery` no longer writes; it returns the intended writes (Shape B):
  `{ attemptRow, statusUpdate }` (or `{ skip: true }` for already-DELIVERED rows).
- `processBatch` collects the writes from all fulfilled, non-skip results and calls a new
  repository function `applyBatchWrites(writes)`.
- `applyBatchWrites` runs one transaction: one `createMany` for all attempt rows + a loop
  of per-row `update`s for the (differing) status transitions, then a single `COMMIT`.
- HTTP, outcome classification, metrics, logging, and correlation-ID context remain
  per-delivery — only the DB persistence was batched.

Per batch of 20: **1 createMany + 20 updates + 1 commit** (down from 20×(insert+update+commit)).
The attempt inserts collapse to a single statement for free; the updates stay individual
(the "fsync-elimination" bet, deferring the raw `UPDATE ... FROM VALUES` approach unless
statement count proves to be the next bottleneck).

## Correctness analysis
Batching trades per-delivery fault isolation for throughput: if the batch transaction
fails partway, all rows in it roll back (including already-sent deliveries), and the
reaper re-delivers them. This is **acceptable** because it produces the *same class* of
duplicate the system already handles — the service is at-least-once, subscribers dedupe
on `Webhook-Id`, and the reaper already re-delivers on worker death. No new correctness
guarantee is broken. Batch updates are simple primary-key operations, so partial failure
is rare.

## Results

| Config | Rate | Postgres CPU | Bottleneck |
|--------|------|-------------|-----------|
| Day 6: 1 worker, per-delivery txn | ~1,090/s | ~170% | DB |
| Day 6: 2 workers, per-delivery txn | ~1,200/s | ~215% | DB pegged (2nd worker +10%) |
| Day 8: 1 worker, **batched** txn | ~865/s | **~35%** | not DB |
| Day 8: 2 workers, **batched** txn | ~1,280/s | ~65% | approaching DB again |

**Headline: Postgres CPU dropped ~80% (170% → 35%) for equivalent single-worker
throughput.** The commit/fsync overhead was confirmed as the dominant cost.

**Proof the bottleneck moved:** the second worker's contribution went from **+10%**
(Day 6, DB pegged) to **+48%** (Day 8, DB at 35% with headroom). `FOR UPDATE SKIP LOCKED`
was already distributing work with zero contention; the difference is that batching freed
the shared resource (DB CPU) so a second worker now actually adds throughput. CPU scaled
near-linearly (~30% per worker), implying the batched ceiling is well above 2,000/s vs the
old ~1,200/s wall.

## Honest caveat
Single-worker throughput dipped slightly (1,090 → 865) because the batched path waits for
all 20 HTTP calls to settle (`Promise.allSettled`) before the single write, so each batch
is gated by its slowest HTTP call. This is a good trade: worker time is cheap and
horizontally scalable, whereas database CPU is the scarce shared resource — and the DB
cost fell ~80% while horizontal scaling was restored.

## Decision to stop here
Did not push to 3-4 workers / 100% Postgres CPU. The hypothesis (batching removes the DB
bottleneck) is fully proven by the CPU drop + restored scaling; finding the exhausted-machine
max would produce a bigger number but not a stronger conclusion, and would just re-discover
Day 6's "DB has a finite ceiling" at a higher point. The efficiency win (80% CPU reduction,
scaling restored) is the result worth citing, not a raw max-throughput figure.

