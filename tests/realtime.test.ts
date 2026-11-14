import { expect, it } from "vitest";
import { Store } from "../server/store";
import { createApp } from "../server/app";

it("closes active authenticated realtime streams during graceful shutdown", async () => {
  const store = new Store({ path: ":memory:" });
  const account = store.register("stream_owner", "temporary-test-password");
  const app = await createApp({
    store,
    liveEnabled: false,
    serveStatic: false,
  });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${base}/api/events`, {
      headers: { Cookie: `session=${account.token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("retry: 3000");
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 500);
        timer.unref();
      }),
    ]);
    expect(closed).toBe(true);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await app.close();
    store.close();
  }
}, 5000);
