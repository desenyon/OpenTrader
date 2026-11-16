> Historical November 14 benchmark. See the [November 16 economy benchmark](../verification/credit-economy.md) for current engine measurements.

# Local performance verification

The final 20-request workload completed with HTTP p95 between **155.130 and 180.257 ms**. A simultaneous 100-user burst had p95 **924.698 ms** and p99 **965.447 ms**. Every intended order filled one share and every request succeeded; all seven accounting reconciliation flags passed. These are local measurements, not a production-capacity claim.

## Reproduce

```sh
npm run benchmark
```

The script creates its own `mkdtemp` directory, uses the actual `Store` and `createApp`, and removes only that temporary database in `finally`. No configured application database is opened. Timestamped JSON is written under `artifacts/`.

[Preserved raw JSON](../verification/benchmark.json). Executed November 14, 2026 at 04:03:05 UTC on Apple M4, arm64 macOS/Darwin 27.2.0, Node v26.11.1, 10 available logical CPUs, 16 GiB RAM. The machine also ran development/QA work; it was not a dedicated load-test host. Source hashes recorded before and after the run are identical.

## Fixture and method

- Real disk-backed SQLite, WAL, `synchronous=FULL`.
- 100 registered users, all active members of the target Friends group. Accounts retain the independent wallets and groups created by normal registration.
- 1,000 approved OPEN binary Friends markets, each with liquidity `b=10`. Creator, approving moderator and resolver are three different users; the resolver reads instead of trading.
- Treasury remaining after funding: 92,068.528000 CR.
- Five warmup orders, five bursts of 20 simultaneous one-share IOC buys, then 99 buys plus a resolver read in the 100-user burst. Requests target separate markets; hot-market contention is outside this run.
- Each order uses a fresh idempotency key, a 0.7500 unit limit, a 0.750000 maximum total cost and a one-share minimum fill. Quote-preview time is excluded.
- HTTP latency runs from scheduled intent through Fastify-inject completion. Scheduled-to-preHandler includes parsing, authentication, rate limiting and event-loop waiting. These lifecycle intervals do not isolate CPU or SQLite time.
- Percentiles use nearest rank. The five 20-request rounds remain separate rather than pooling percentile summaries.

## Observed latency

All values are milliseconds. Each latency cell is **p50 / p95 / p99**.

| Workload | HTTP latency | Scheduled → preHandler | Success / reject |
| --- | --- | --- | --- |
| typical-20-round-1 | 82.204 / 155.130 / 161.841 | 74.719 / 148.064 / 155.168 | 20 / 0 |
| typical-20-round-2 | 90.083 / 164.081 / 174.902 | 79.470 / 157.263 / 164.103 | 20 / 0 |
| typical-20-round-3 | 88.265 / 167.231 / 178.101 | 77.634 / 160.224 / 167.258 | 20 / 0 |
| typical-20-round-4 | 92.241 / 175.756 / 187.214 | 80.757 / 168.338 / 175.776 | 20 / 0 |
| typical-20-round-5 | 97.621 / 180.257 / 192.501 | 86.291 / 172.900 / 180.285 | 20 / 0 |
| 100-active-user-burst | 473.322 / 924.698 / 965.447 | 465.819 / 912.212 / 953.091 | 100 / 0 |

The 100-user burst completed in **973.356 ms**. PreHandler-to-onSend p50/p95/p99 was **8.203 / 12.527 / 12.658 ms**; scheduled-to-preHandler p95 was **912.212 ms**. All 99 order responses filled one share. There were no HTTP errors or protection rejections. Warmup succeeded 5/5 and is excluded above.

## Persistence and reconciliation

Registration took 2,070.450 ms, group enrollment 55.642 ms, and 1,000 independently committed creations/approvals 5,947.119 ms. Total setup was 8,408.341 ms. Final full reconciliation took 369.401 ms; the whole run took 10,713.420 ms before cleanup.

At measurement end the database occupied 10,391,552 bytes, its WAL 6,171,792 bytes and the serialized state record 2,463,177 bytes. These are pre-checkpoint sizes, not the final compacted footprint.

All reconciliation flags were true: balanced, journalBalanced, projectionsMatch, nonnegative, inventoryMatches, escrowsSolvent and locksMatch.

## Bottleneck evidence and limits

Most 100-user tail delay accumulated before the handler. Synchronous exchange math and SQLite commits share one Node event loop. Each economic transaction serializes the complete state record; at 1,000 markets and 2.46 MB, serialization and synchronous writes plausibly contribute to request accumulation. This is an inference from lifecycle timing and source inspection; serialization, fsync and math were not separately profiled.

The typical 20-order burst meets the proposed 400 ms target in this finite sample. The 100-user burst does not meet that target. Earlier pre-final-source measurements were faster (20-request p95 137–142 ms; 100-user p95 766 ms); this report uses the final run rather than selecting the best result.

Fastify inject omits TCP/TLS, actual networks, browser rendering, SSE fanout, upstream provider latency and sustained load. Separate-market one-share orders do not prove large-lot or hot-market capacity. The application is a single-host release; stricter simultaneous-user tails require further optimization and fresh load tests. No availability SLA or production throughput is claimed.
