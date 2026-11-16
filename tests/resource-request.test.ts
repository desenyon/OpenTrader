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
it("queues a fresh balance read when a mutation invalidates an older in-flight response", async () => {
  const resolvers: ((value: number) => void)[] = [],
    values: number[] = [];
  const resource = createResourceRequest(
    () => new Promise<number>((resolve) => resolvers.push(resolve)),
    (value) => values.push(value),
    () => {},
  );
  const pending = resource.refresh();
  await Promise.resolve();
  const invalidated = resource.refresh(true);
  expect(invalidated).toBe(pending);
  resolvers[0]!(10000);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(resolvers).toHaveLength(2);
  expect(values).toEqual([]);
  resolvers[1]!(10200);
  await invalidated;
  expect(values).toEqual([10200]);
});
it("coalesces multiple balance invalidations and ignores a stale failure", async () => {
  const loads: {
      resolve: (value: number) => void;
      reject: (error: Error) => void;
    }[] = [],
    values: number[] = [],
    errors: unknown[] = [];
  const resource = createResourceRequest(
    () =>
      new Promise<number>((resolve, reject) => loads.push({ resolve, reject })),
    (v) => values.push(v),
    (e) => errors.push(e),
  );
  const first = resource.refresh();
  await Promise.resolve();
  resource.refresh(true);
  resource.refresh(true);
  resource.refresh(true);
  loads[0]!.reject(new Error("old session request failed"));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(loads).toHaveLength(2);
  expect(errors).toEqual([]);
  loads[1]!.resolve(10500);
  await first;
  expect(values).toEqual([10500]);
});
it("does not lose an invalidation between publishing a response and completing its promise", async () => {
  let calls = 0;
  const values: number[] = [];
  const resource = createResourceRequest(
    async () => ++calls,
    (value) => {
      values.push(value);
      if (value === 1) queueMicrotask(() => void resource.refresh(true));
    },
    () => {},
  );
  await resource.refresh();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(values).toEqual([1, 2]);
  expect(calls).toBe(2);
});
