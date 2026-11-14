import { useCallback, useEffect, useRef, useState } from "react";
import { createResourceRequest } from "./resource-request";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let data: { error?: string; code?: string } = {};
    try {
      data = await response.json();
    } catch {
      /* Transport may have no JSON body. */
    }
    throw new ApiError(
      data.error || `Request failed (${response.status})`,
      data.code || "REQUEST_FAILED",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const post = <T>(
  path: string,
  body: unknown = {},
  headers?: Record<string, string>,
) => api<T>(path, { method: "POST", body: JSON.stringify(body), headers });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

const listeners = new Set<() => void>();
export function refreshAll() {
  for (const listener of listeners) listener();
}
export function useResource<T>(path: string | null, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const current = useRef(path);
  const requestRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => requestRef.current(), []);
  useEffect(() => {
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (current.current !== path) {
      current.current = path;
      setData(undefined);
      setUpdatedAt(null);
      setError("");
    }
    if (!path) {
      requestRef.current = () => {};
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const resource = createResourceRequest(
      () => api<T>(path, { signal: controller.signal }),
      (result) => {
        setData(result);
        setError("");
        setUpdatedAt(Date.now());
      },
      (reason) =>
        setError(
          reason instanceof Error ? reason.message : "Connection failed",
        ),
      setLoading,
    );
    const fetchResource = () => {
      if (document.visibilityState === "hidden") return;
      void resource.refresh();
    };
    requestRef.current = fetchResource;
    void fetchResource();
    const timer = interval
      ? window.setInterval(() => void fetchResource(), interval)
      : undefined;
    const visible = () => {
      if (document.visibilityState === "visible") void fetchResource();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      resource.dispose();
      controller.abort();
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, interval]);
  return {
    data: current.current === path ? data : undefined,
    error: current.current === path ? error : "",
    loading,
    updatedAt: current.current === path ? updatedAt : null,
    refresh,
  };
}
export function useEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/events");
    source.onmessage = () => refreshAll();
    for (const type of ["market", "order", "fill", "notification", "refresh"])
      source.addEventListener(type, () => refreshAll());
    return () => source.close();
  }, [enabled]);
}
