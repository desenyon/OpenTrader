export function createResourceRequest<T>(
  load: () => Promise<T>,
  success: (value: T) => void,
  failure: (reason: unknown) => void,
  loading: (pending: boolean) => void = () => {},
) {
  let active = true;
  let pending: Promise<void> | undefined;
  let invalidated = false;
  return {
    refresh(invalidate = false): Promise<void> {
      if (!active) return Promise.resolve();
      if (pending) {
        invalidated ||= invalidate;
        return pending;
      }
      loading(true);
      pending = Promise.resolve().then(async () => {
        try {
          do {
            invalidated = false;
            try {
              const value = await load();
              if (active && !invalidated) success(value);
            } catch (reason) {
              if (active && !invalidated) failure(reason);
            }
          } while (active && invalidated);
        } finally {
          // Clear synchronously with completing the drain. A later microtask
          // must start a fresh request, rather than attach to a finished one.
          pending = undefined;
          if (active) loading(false);
        }
      });
      return pending;
    },
    dispose() {
      active = false;
    },
  };
}
