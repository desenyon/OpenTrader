export const credits = (value: string | number | undefined, decimals = 2) =>
  value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
      }).format(Number(value));
export const compact = (value: number | undefined) =>
  value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
export const cents = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}¢`;
export const percent = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
export const date = (value: string | undefined) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const day = (value: string | undefined) =>
  value
    ? new Date(value).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";
export const uid = () => crypto.randomUUID();
export const short = (value: string) => value.slice(0, 7);
