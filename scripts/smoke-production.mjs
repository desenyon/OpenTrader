import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const directory = mkdtempSync(join(tmpdir(), "opentrader-production-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
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
  assert.equal(bootstrap.wallets.length, 2);
  assert.equal(bootstrap.groups.length, 1);
  console.log(
    "Production smoke passed: executable bundle, HTTP health, static HTML, Brotli assets, immutable asset caching, hosted data gate, account/session, and isolated wallets.",
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
  rmSync(directory, { recursive: true, force: true });
}
