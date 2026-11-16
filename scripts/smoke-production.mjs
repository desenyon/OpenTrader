import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const directory = mkdtempSync(join(tmpdir(), "opentrader-production-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const credentialsFile = join(directory, "admin.txt");
const provision = spawnSync(
  process.execPath,
  [
    "dist-server/create-admin.js",
    "--database",
    join(directory, "test.sqlite"),
    "--credentials",
    credentialsFile,
    "--handle",
    "smoke_admin",
  ],
  { encoding: "utf8" },
);
if (provision.status !== 0) rmSync(directory, { recursive: true, force: true });
assert.equal(
  provision.status,
  0,
  "Built administrator provisioning must succeed",
);
const secret = /Password: (.+)/.exec(readFileSync(credentialsFile, "utf8"))[1];
const child = spawn(process.execPath, ["dist-server/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: join(directory, "test.sqlite"),
    LIVE_DATA_ENABLED: "false",
    DATA_USE_ACKNOWLEDGED: "false",
    COOKIE_SECURE: "false",
    REGISTRATION_OPEN: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Built server exited before startup:\n${output}`);
    try {
      ready = (await fetch(`${base}/api/health`)).ok;
    } catch {
      /* Process is starting. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Built server did not become healthy:\n${output}`);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.ok(
    page.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
  );
  const html = await page.text();
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "Production HTML must reference a built JavaScript asset");
  const asset = await fetch(`${base}${script}`, {
    headers: { "Accept-Encoding": "br,gzip" },
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-encoding"), "br");
  assert.ok(asset.headers.get("cache-control")?.includes("immutable"));
  const gated = await fetch(`${base}/api/markets?exchange=LIVE`);
  assert.equal(
    gated.status,
    503,
    "Hosted live data must stay gated without acknowledgement",
  );
  const registration = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({
      handle: "packaging_smoke",
      anonymousTrading: true,
      password: "isolated-test-only-password",
    }),
  });
  assert.equal(registration.status, 200);
  const cookie = registration.headers.get("set-cookie");
  assert.ok(cookie?.includes("HttpOnly"));
  const bootstrap = await (
    await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookie.split(";")[0] },
    })
  ).json();
  assert.equal(bootstrap.user.handle, "packaging_smoke");
  assert.equal(bootstrap.user.status, "PENDING");
  assert.equal(bootstrap.user.anonymousTrading, true);
  assert.equal(bootstrap.user.platformRole, "USER");
  assert.equal(bootstrap.wallets.length, 0);
  assert.equal(bootstrap.groups.length, 0);
  const pendingHeaders = { Cookie: cookie.split(";")[0] };
  assert.equal(
    (await fetch(`${base}/api/wallets`, { headers: pendingHeaders })).status,
    403,
  );
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ handle: "smoke_admin", password: secret }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.platformRole, "ADMIN");
  const adminHeaders = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "Content-Type": "application/json",
    Origin: base,
  };
  const approve = await fetch(`${base}/api/admin/actions`, {
    method: "POST",
    headers: { ...adminHeaders, "Idempotency-Key": "production-approval" },
    body: JSON.stringify({
      type: "ACCOUNT_STATUS",
      targetId: bootstrap.user.id,
      status: "APPROVED",
    }),
  });
  assert.equal(approve.status, 200);
  const approved = await (
    await fetch(`${base}/api/bootstrap`, { headers: pendingHeaders })
  ).json();
  assert.equal(approved.user.anonymousTrading, true);
  assert.equal(approved.wallets.length, 2);
  assert.equal(approved.groups.length, 1);
  assert.ok(
    approved.wallets.every((wallet) => wallet.available === "10000.000000"),
  );
  const report = await fetch(`${base}/api/admin/report?section=users`, {
    headers: adminHeaders,
  });
  assert.equal(report.status, 200);
  assert.equal((await report.json()).total, 2);
  const reconciliation = await (
    await fetch(`${base}/api/admin/reconciliation`, { headers: adminHeaders })
  ).json();
  assert.equal(reconciliation.balanced, true);
  console.log(
    "Production smoke passed: executable bundle, HTTP health, static HTML, Brotli assets, immutable asset caching, hosted data gate, anonymous signup, CLI admin login, reason-free approval, isolated wallets, admin reporting and reconciliation.",
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
  rmSync(directory, { recursive: true, force: true });
}
