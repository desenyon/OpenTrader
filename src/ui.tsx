import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { errorMessage } from "./utils";

export function IconButton({
  label,
  children,
  onClick,
  className = "",
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">∅</span>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
export function ErrorNote({ message }: { message?: string }) {
  return message ? (
    <div className="error-note" role="alert">
      <AlertCircle size={13} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <span className="loading">
      <LoaderCircle size={13} className="spin" />
      {children}
    </span>
  );
}
export function Select({
  value,
  onChange,
  children,
  label,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div className={`select-wrap ${className}`}>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={12} />
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = setTimeout(
      () =>
        (
          (panel.current?.querySelector(
            "input:not(:disabled):not([readonly]), textarea:not(:disabled), select:not(:disabled)",
          ) ||
            panel.current?.querySelector(
              "button:not(:disabled)",
            )) as HTMLElement | null
        )?.focus(),
      20,
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
          ) || [],
        );
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);
  return createPortal(
    <div
      className="modal-shade"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
      >
        <header className="modal-header">
          <div>
            {eyebrow && <small>{eyebrow}</small>}
            <h2>{title}</h2>
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function ActionForm({
  children,
  onSubmit,
  submitLabel,
  onSuccess,
  className = "",
}: {
  children: ReactNode;
  onSubmit: (form: FormData) => Promise<unknown>;
  submitLabel: string;
  onSuccess?: (result: unknown) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      const result = await onSubmit(new FormData(event.currentTarget));
      setSuccess(true);
      onSuccess?.(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className={`form ${className}`}>
      {children}
      <ErrorNote message={error} />
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? (
          <Loading>Working…</Loading>
        ) : (
          <>
            {success && <Check size={14} />}
            {submitLabel}
          </>
        )}
      </button>
      {success && (
        <span className="success-note" role="status">
          Saved successfully.
        </span>
      )}
    </form>
  );
}
