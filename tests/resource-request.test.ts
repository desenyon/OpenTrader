import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceRequest } from "../src/resource-request";
afterEach(() => vi.useRealTimers());

describe("resource refresh coordination", () => {
  it("publishes a slow result even when realtime refresh arrives during the request", async () => {
    vi.useFakeTimers();
    const results: number[] = [];
    const loader = vi.fn(
      () =>
        new Promise<number>((resolve) => setTimeout(() => resolve(42), 3500)),
    );
    const resource = createResourceRequest(
      loader,
      (value) => results.push(value),
      () => {},
    );
    const first = resource.refresh();
    await vi.advanceTimersByTimeAsync(3000);
    const second = resource.refresh();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(500);
    await second;
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toEqual([42]);
  });
  it("ignores an old path result after its resource has been disposed", async () => {
    let resolve!: (value: string) => void;
    const values: string[] = [];
    const resource = createResourceRequest(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
      (value) => values.push(value),
      () => {},
    );
    const promise = resource.refresh();
    await Promise.resolve();
    resource.dispose();
    resolve("private old scope");
    await promise;
    expect(values).toEqual([]);
  });
  it("can retry after a rejected request without accumulating in-flight requests", async () => {
    const errors: string[] = [],
      values: number[] = [];
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(7);
    const resource = createResourceRequest<number>(
      loader,
      (value) => values.push(value),
      (reason) => errors.push(String(reason)),
    );
    await resource.refresh();
    await resource.refresh();
    expect(errors).toHaveLength(1);
    expect(values).toEqual([7]);
  });
});
