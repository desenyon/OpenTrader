export function createResourceRequest<T>(
  load: () => Promise<T>,
  success: (value: T) => void,
  failure: (reason: unknown) => void,
  loading: (pending: boolean) => void = () => {},
) {
  let active = true;
  let pending: Promise<void> | undefined;
  return {
    refresh(): Promise<void> {
      if (!active) return Promise.resolve();
      if (pending) return pending;
      loading(true);
      pending = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            if (active) success(value);
          },
          (reason) => {
            if (active) failure(reason);
          },
        )
        .finally(() => {
          pending = undefined;
          if (active) loading(false);
        });
      return pending;
    },
    dispose() {
      active = false;
    },
  };
}
