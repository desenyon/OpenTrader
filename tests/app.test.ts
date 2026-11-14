import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../server/app";

const apps: FastifyInstance[] = [];
async function app() {
  const server = await createApp({
    databasePath: ":memory:",
    liveEnabled: false,
    serveStatic: false,
  });
  apps.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("application security boundary", () => {
  it("rejects a different localhost application as an origin", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: "http://localhost:4444", host: "localhost:3001" },
      payload: { handle: "local_attacker", password: "long-enough-password" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("ORIGIN_REJECTED");
  });

  it("does not bypass login rate limits using random invalid cookies", async () => {
    const a = await app();
    let status = 0;
    for (let i = 0; i < 21; i++) {
      status = (
        await a.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { cookie: `session=not-a-real-session-${i}` },
          payload: { handle: "unknown", password: "test-only-password" },
        })
      ).statusCode;
    }
    expect(status).toBe(429);
  });
  it("offers a health check without exposing private economic data", async () => {
    const a = await app();
    const response = await a.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.1.0" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("rejects cross-origin mutations before creating any account", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: "https://attacker.example", host: "localhost:3001" },
      payload: { handle: "malicious", password: "long-enough-password" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("ORIGIN_REJECTED");
    const bootstrap = await a.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.json().user).toBeNull();
  });

  it("keeps API 404 responses JSON instead of falling back to the web application", async () => {
    const a = await app();
    const response = await a.inject("/api/not-a-route");
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toHaveProperty("code");
  });

  it("bounds request sizes rather than accepting arbitrarily large evidence/comments", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "big", password: "x".repeat(100_000) },
    });
    expect(response.statusCode).toBe(413);
  });

  it("does not enable hosted data redistribution implicitly", async () => {
    const a = await app();
    const response = await a.inject("/api/live/status");
    expect(response.statusCode).toBe(200);
    expect(response.json().enabled).toBe(false);
  });
});
