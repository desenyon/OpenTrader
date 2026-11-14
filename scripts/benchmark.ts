/**
 * Reproducible local benchmark. Run: npx tsx scripts/benchmark.ts
 * Uses only a fresh mkdtemp SQLite database and real Store/Fastify routes.
 * Never reads or mutates the application's configured database.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  availableParallelism,
  cpus,
  freemem,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type { Market, OrderInput } from "../shared/types";
import { createApp } from "../server/app";
import { Store } from "../server/store";

const USER_COUNT = 100;
const MARKET_COUNT = 1000;
const LIQUIDITY_B = 10;
const SETUP_NOW = new Date();
const deadline = new Date(
  SETUP_NOW.getTime() + 7 * 24 * 3600_000,
).toISOString();
const fingerprintPaths = [
  "server/store.ts",
  "server/math.ts",
  "server/app.ts",
  "server/routes.ts",
  "scripts/benchmark.ts",
];
async function fingerprintSources() {
  const hashes: Record<string, string> = {};
  for (const path of fingerprintPaths)
    hashes[path] = createHash("sha256")
      .update(await readFile(resolve(path)))
      .digest("hex");
  return hashes;
}
const sourceSha256AtStart = await fingerprintSources();
const tempDirectory = await mkdtemp(join(tmpdir(), "opentrader-benchmark-"));
const databasePath = join(tempDirectory, "benchmark.sqlite");
const startedAt = new Date().toISOString();
const totalStart = performance.now();
const store = new Store({ path: databasePath });
let app: FastifyInstance | undefined;
const log = (message: string) => {
  process.stdout.write(`${message}\n`);
};
const timings = new Map<
  string,
  {
    scheduled: number;
    onRequest?: number;
    preHandler?: number;
    onSend?: number;
  }
>();

function percentile(sorted: number[], fraction: number) {
  if (!sorted.length) return null;
  return Number(
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(3),
  );
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted.length ? Number(sorted[0]!.toFixed(3)) : null,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length ? Number(sorted.at(-1)!.toFixed(3)) : null,
    meanMs: sorted.length
      ? Number((sorted.reduce((s, n) => s + n, 0) / sorted.length).toFixed(3))
      : null,
  };
}

type Intent = { userIndex: number; marketIndex: number; read?: boolean };
type Result = {
  kind: "order" | "read";
  status: number;
  code?: string;
  filledQuantity?: number;
  totalMs: number;
  queueMs?: number;
  preHandlerMs?: number;
  handlerToSendMs?: number;
};
async function burst(name: string, intents: Intent[]) {
  assert(app);
  const burstStart = performance.now();
  // All intent timestamps are captured before dispatch, so synchronous event-loop
  // backlog is included rather than hidden by timing only inside each handler.
  const scheduled = intents.map((intent) => ({
    intent,
    requestId: randomUUID(),
    scheduledAt: performance.now(),
  }));
  const results: Result[] = await Promise.all(
    scheduled.map(async ({ intent, requestId, scheduledAt }) => {
      timings.set(requestId, { scheduled: scheduledAt });
      const user = users[intent.userIndex]!,
        market = markets[intent.marketIndex]!;
      const input: OrderInput = {
        marketId: market.id,
        outcomeId: "yes",
        side: "BUY",
        quantity: 1,
        limitPrice: "0.7500",
        timeInForce: "IOC",
        maxTotalCost: "0.750000",
        minFillQuantity: 1,
      };
      const response = await app!.inject({
        method: intent.read ? "GET" : "POST",
        url: intent.read ? `/api/markets/${market.id}` : "/api/orders",
        headers: {
          cookie: `session=${user.token}`,
          "x-benchmark-id": requestId,
          ...(intent.read ? {} : { "idempotency-key": randomUUID() }),
        },
        ...(intent.read ? {} : { payload: input }),
      });
      const finishedAt = performance.now();
      const timing = timings.get(requestId)!;
      timings.delete(requestId);
      const body = response.json();
      return {
        kind: intent.read ? "read" : "order",
        status: response.statusCode,
        ...(body.code ? { code: body.code } : {}),
        ...(body.order ? { filledQuantity: body.order.filledQuantity } : {}),
        totalMs: finishedAt - scheduledAt,
        ...(timing.onRequest !== undefined
          ? { queueMs: timing.onRequest - scheduledAt }
          : {}),
        ...(timing.preHandler !== undefined
          ? { preHandlerMs: timing.preHandler - scheduledAt }
          : {}),
        ...(timing.preHandler !== undefined && timing.onSend !== undefined
          ? { handlerToSendMs: timing.onSend - timing.preHandler }
          : {}),
      };
    }),
  );
  const durationMs = performance.now() - burstStart;
  const statusCounts: Record<string, number> = {},
    rejectionCodes: Record<string, number> = {};
  for (const result of results) {
    statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
    if (result.code)
      rejectionCodes[result.code] = (rejectionCodes[result.code] || 0) + 1;
  }
  const report = {
    name,
    concurrency: intents.length,
    durationMs: Number(durationMs.toFixed(3)),
    successes: results.filter((r) => r.status >= 200 && r.status < 300).length,
    rejects: results.filter((r) => r.status >= 400).length,
    successfulOrders: results.filter(
      (r) => r.kind === "order" && r.status === 200 && r.filledQuantity === 1,
    ).length,
    successfulReads: results.filter(
      (r) => r.kind === "read" && r.status === 200,
    ).length,
    statusCounts,
    rejectionCodes,
    httpLatency: summary(results.map((r) => r.totalMs)),
    queueToOnRequest: summary(
      results.flatMap((r) => (r.queueMs === undefined ? [] : [r.queueMs])),
    ),
    scheduledToPreHandler: summary(
      results.flatMap((r) =>
        r.preHandlerMs === undefined ? [] : [r.preHandlerMs],
      ),
    ),
    preHandlerToOnSend: summary(
      results.flatMap((r) =>
        r.handlerToSendMs === undefined ? [] : [r.handlerToSendMs],
      ),
    ),
  };
  assert.equal(
    report.queueToOnRequest.count,
    intents.length,
    "Every request needs queue instrumentation",
  );
  assert.equal(
    report.scheduledToPreHandler.count,
    intents.length,
    "Every request needs handler instrumentation",
  );
  log(
    `${name}: ${report.successes}/${intents.length} success, ${report.rejects} rejected; HTTP p50=${report.httpLatency.p50Ms}ms p95=${report.httpLatency.p95Ms}ms p99=${report.httpLatency.p99Ms}ms; ${report.durationMs}ms burst`,
  );
  return report;
}

const users: ReturnType<Store["register"]>[] = [];
const markets: Market[] = [];
try {
  log(
    `Isolated disk-backed SQLite WAL/FULL benchmark: ${USER_COUNT} users, ${MARKET_COUNT} OPEN markets, b=${LIQUIDITY_B}.`,
  );
  const registrationStart = performance.now();
  for (let i = 0; i < USER_COUNT; i++) {
    users.push(
      store.register(
        `benchmark_${String(i).padStart(3, "0")}`,
        "isolated-benchmark-password-only",
      ),
    );
    if ((i + 1) % 20 === 0) {
      log(`Registered ${i + 1}/${USER_COUNT} users.`);
      await yieldToLoop();
    }
  }
  const registrationMs = performance.now() - registrationStart;
  const owner = users[0]!,
    moderator = users[1]!,
    resolver = users[USER_COUNT - 1]!;
  const group = store.groups(owner.user.id)[0]!;
  const invite = store.invite(owner.user.id, group.id, {
    uses: 100,
    expiresHours: 24,
  });
  const membershipStart = performance.now();
  for (const user of users.slice(1)) store.redeem(user.user.id, invite.token);
  store.changeMember(owner.user.id, group.id, moderator.user.id, {
    role: "MODERATOR",
  });
  const membershipMs = performance.now() - membershipStart;
  const creationStart = performance.now();
  for (let i = 0; i < MARKET_COUNT; i++) {
    const market = store.createMarket(owner.user.id, {
      groupId: group.id,
      question: `Will benchmark condition ${String(i).padStart(4, "0")} be met by the deadline?`,
      category: "Benchmark",
      description:
        "Isolated performance fixture; never displayed as a real prediction.",
      closeAt: deadline,
      b: LIQUIDITY_B,
      rules: {
        condition: `The isolated deterministic fixture ${i} reports success.`,
        source: "Isolated benchmark fixture, no external market data.",
        evidence: "Fixture completion record.",
        observationAt: deadline,
        voidPolicy: "Neutral void at frozen longstop; 0.50 CR per share.",
        disputeHours: 24,
        resolverId: resolver.user.id,
        reviewerIds: [],
      },
    });
    markets.push(store.approveMarket(moderator.user.id, market.id));
    if ((i + 1) % 100 === 0) {
      log(
        `Created and independently approved ${i + 1}/${MARKET_COUNT} markets (${((performance.now() - creationStart) / 1000).toFixed(1)}s).`,
      );
      await yieldToLoop();
    }
  }
  const creationAndApprovalMs = performance.now() - creationStart;
  assert.equal(
    store.markets(owner.user.id, group.id).filter((m) => m.status === "OPEN")
      .length,
    MARKET_COUNT,
  );
  assert.equal(
    store.members(owner.user.id, group.id).filter((m) => m.status === "ACTIVE")
      .length,
    USER_COUNT,
  );
  const fundedTreasury = store
    .groups(owner.user.id)
    .find((g) => g.id === group.id)!.treasury;
  app = await createApp({
    store,
    liveEnabled: false,
    serveStatic: false,
    logger: false,
  });
  app.addHook("onRequest", async (request) => {
    const id = request.headers["x-benchmark-id"];
    if (typeof id === "string") {
      const value = timings.get(id);
      if (value) value.onRequest = performance.now();
    }
  });
  app.addHook("preHandler", async (request) => {
    const id = request.headers["x-benchmark-id"];
    if (typeof id === "string") {
      const value = timings.get(id);
      if (value) value.preHandler = performance.now();
    }
  });
  app.addHook("onSend", async (request) => {
    const id = request.headers["x-benchmark-id"];
    if (typeof id === "string") {
      const value = timings.get(id);
      if (value) value.onSend = performance.now();
    }
  });
  await app.ready();
  const setupMs = performance.now() - totalStart;
  log(
    `Setup finished in ${(setupMs / 1000).toFixed(2)}s; target treasury remaining ${fundedTreasury} CR.`,
  );
  const warmup = await burst(
    "warmup-5",
    Array.from({ length: 5 }, (_, i) => ({ userIndex: i, marketIndex: i })),
  );
  const typical = [];
  for (let round = 0; round < 5; round++) {
    await yieldToLoop();
    typical.push(
      await burst(
        `typical-20-round-${round + 1}`,
        Array.from({ length: 20 }, (_, i) => ({
          userIndex: (round * 20 + i) % (USER_COUNT - 1),
          marketIndex: 10 + round * 20 + i,
        })),
      ),
    );
  }
  await yieldToLoop();
  const hundredUsers = await burst(
    "100-active-user-burst",
    Array.from({ length: USER_COUNT }, (_, i) => ({
      userIndex: i,
      marketIndex: 200 + i,
      read: i === USER_COUNT - 1,
    })),
  );
  const reconciliationStart = performance.now();
  const reconciliation = store.reconcile(owner.user.id);
  const reconciliationMs = performance.now() - reconciliationStart;
  const databaseBytes = (await stat(databasePath)).size;
  const walBytes = await stat(`${databasePath}-wal`)
    .then((s) => s.size)
    .catch(() => 0);
  const stateBytes = Number(
    (
      store.db
        .prepare(
          "SELECT length(CAST(data AS BLOB)) AS size FROM state WHERE id=1",
        )
        .get() as { size: number }
    ).size,
  );
  const sourceSha256AtEnd = await fingerprintSources();
  const sourceChangedDuringRun = fingerprintPaths.filter(
    (path) => sourceSha256AtStart[path] !== sourceSha256AtEnd[path],
  );
  const result = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      availableParallelism: availableParallelism(),
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
    },
    fixture: {
      users: USER_COUNT,
      activeGroupMembers: USER_COUNT,
      openFriendsMarkets: MARKET_COUNT,
      liquidityB: LIQUIDITY_B,
      targetTreasuryRemaining: fundedTreasury,
      independentCreatorModeratorResolver: true,
      oneShareLots: true,
      buyLimitPrice: "0.7500",
      hardMaxTotalCost: "0.750000",
      minimumFillQuantity: 1,
      exchanges: ["FRIENDS"],
      sqlite: {
        diskBacked: true,
        journalMode: "WAL",
        synchronous: "FULL",
        databaseBytes,
        walBytes,
        serializedStateBytes: stateBytes,
      },
    },
    setup: {
      registrationMs: Number(registrationMs.toFixed(3)),
      membershipMs: Number(membershipMs.toFixed(3)),
      creationAndApprovalMs: Number(creationAndApprovalMs.toFixed(3)),
      totalMs: Number(setupMs.toFixed(3)),
    },
    warmup,
    typical20: typical,
    hundredUsers,
    reconciliation: {
      ...reconciliation,
      durationMs: Number(reconciliationMs.toFixed(3)),
    },
    totalDurationMs: Number((performance.now() - totalStart).toFixed(3)),
    sourceSha256AtStart,
    sourceSha256AtEnd,
    sourceChangedDuringRun,
    limitations: [
      "Local in-process Fastify inject; no TCP, TLS, browser rendering, external provider latency, or network queueing.",
      "Concurrency means simultaneously submitted request intents on one Node process; SQLite and exchange math execute synchronously on the event loop.",
      "Queue-to-onRequest includes injection dispatch and earlier request hooks; scheduled-to-preHandler also includes auth, rate-limit, parsing, and event-loop delay.",
      "Five 20-request bursts and one 100-user burst are finite samples, not a sustained throughput or production capacity claim.",
      "All measured orders use different funded markets and fresh idempotency keys; market contention, provider quotes, and large-lot matching are outside this run.",
      "Registration scrypt and 1,000 independently committed creations/approvals are setup; neither is included in request latency.",
      "Protected order-submission phase only: hard price/cash limits and minimum fill are supplied; quote-preview HTTP latency is not included.",
    ],
  };
  const artifacts = resolve("artifacts");
  await mkdir(artifacts, { recursive: true });
  const artifactPath = join(
    artifacts,
    `benchmark-${startedAt.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
  log(
    `Reconciliation ${reconciliation.balanced ? "PASS" : "FAIL"} in ${reconciliationMs.toFixed(1)}ms. JSON: ${artifactPath}`,
  );
  assert(reconciliation.balanced, "Accounting reconciliation must pass");
  assert.equal(
    hundredUsers.successes,
    USER_COUNT,
    "All 100 funded/authorized user intents should succeed",
  );
  for (const round of typical)
    assert.equal(
      round.successes,
      20,
      "All protected typical one-share orders should succeed",
    );
} finally {
  if (app) await app.close();
  store.close();
  await rm(tempDirectory, { recursive: true, force: true });
  log("Removed only the benchmark-owned temporary database directory.");
}
