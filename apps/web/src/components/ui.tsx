import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Copy,
  Eye,
  Minus,
  RotateCcw,
  WifiOff,
  X,
} from "lucide-react";
import { ApiError } from "../lib/api";
import {
  DECISION,
  UNKNOWN_COPY,
  componentState,
  describeReason,
  paymentState,
  tripState,
  type Tone,
} from "../lib/labels";
import type { DecisionOutcome } from "../lib/types";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Ring({ label = "Running" }: { label?: string }) {
  return (
    <svg className="ring" viewBox="0 0 12 12" role="img" aria-label={label}>
      <circle className="rest" cx="6" cy="6" r="4.8" />
      <circle className="arc" cx="6" cy="6" r="4.8" pathLength={100} />
    </svg>
  );
}

const TONE_GLYPH: Partial<Record<Tone, ReactNode>> = {
  success: <Check aria-hidden />,
  "success-outline": <RotateCcw aria-hidden />,
  danger: <X aria-hidden />,
  amber: <AlertTriangle aria-hidden />,
  review: <Eye aria-hidden />,
  unknown: <CircleHelp aria-hidden />,
  info: <CircleDot aria-hidden />,
  outline: <CircleDashed aria-hidden />,
  neutral: <Minus aria-hidden />,
};

export function Chip({
  tone,
  children,
  running,
  enumStyle,
  icon,
  title,
  state,
}: {
  tone: Tone;
  children: ReactNode;
  running?: boolean;
  enumStyle?: boolean;
  icon?: ReactNode;
  title?: string;
  /** The D4 name behind the label, exposed for tests and assistive tooling. */
  state?: string;
}) {
  return (
    <span className={cx("chip", `tone-${tone}`, enumStyle && "chip-enum")} title={title} data-role={state ? "state-chip" : undefined} data-state={state}>
      {running ? <Ring label="In progress" /> : (icon ?? TONE_GLYPH[tone])}
      {children}
    </span>
  );
}

const DECISION_GLYPH: Record<DecisionOutcome, ReactNode> = {
  ACT: <ArrowRight aria-hidden />,
  NO_ACTION: <Minus aria-hidden />,
  UNKNOWN: <CircleHelp aria-hidden />,
  REFUSE: <Ban aria-hidden />,
  MANUAL_REVIEW: <Eye aria-hidden />,
};

export function DecisionChip({ outcome }: { outcome: DecisionOutcome }) {
  const d = DECISION[outcome];
  return (
    <Chip tone={d.tone} enumStyle icon={DECISION_GLYPH[outcome]} title={d.meaning} state={outcome}>
      {d.label}
    </Chip>
  );
}

export function TripStateChip({ state }: { state: string }) {
  const s = tripState(state);
  return (
    <Chip tone={s.tone} running={s.running} state={state}>
      {s.label}
    </Chip>
  );
}

export function ComponentStateChip({ state }: { state: string }) {
  const s = componentState(state);
  return (
    <Chip tone={s.tone} running={s.running} state={state}>
      {s.label}
    </Chip>
  );
}

export function PaymentStateChip({ state }: { state: string }) {
  const s = paymentState(state);
  return (
    <Chip tone={s.tone} running={s.running} state={state}>
      {s.label}
    </Chip>
  );
}

type ButtonVariant = "primary" | "secondary" | "quiet" | "dark" | "danger";

export function Button({
  variant = "primary",
  size,
  loading,
  block,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "lg";
  loading?: boolean;
  block?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("btn", `btn-${variant}`, size && `btn-${size}`, block && "btn-block", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Ring label="Working" /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  to,
  variant = "primary",
  size,
  children,
  className,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: "sm" | "lg";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link to={to} className={cx("btn", `btn-${variant}`, size && `btn-${size}`, className)}>
      {children}
    </Link>
  );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return [copied, copy];
}

export function HashText({ value, label, full }: { value: string; label?: string; full?: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <span className="hash">
      <span className="hash-text" title={value}>
        {full ? value : value.length > 30 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value}
      </span>
      <button type="button" className="icon-btn" onClick={() => copy(value)} aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </button>
    </span>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="copy-field">
      <span className="copy-value" title={value}>
        {value}
      </span>
      <button type="button" className="copy-btn" onClick={() => copy(value)} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Notice({
  kind,
  title,
  children,
  icon,
}: {
  kind: "unknown" | "refuse" | "review" | "danger" | "success" | "info";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const glyph =
    icon ??
    {
      unknown: <CircleHelp aria-hidden />,
      refuse: <Ban aria-hidden />,
      review: <Eye aria-hidden />,
      danger: <AlertTriangle aria-hidden />,
      success: <CircleCheck aria-hidden />,
      info: <CircleCheck aria-hidden />,
    }[kind];
  return (
    <div className={cx("notice", `notice-${kind}`)} role={kind === "danger" || kind === "unknown" ? "status" : undefined}>
      {glyph}
      <div>
        {title ? <strong>{title}</strong> : null}
        {title && children ? " " : null}
        {children}
      </div>
    </div>
  );
}

export function UnknownNotice() {
  return <Notice kind="unknown">{UNKNOWN_COPY}</Notice>;
}

export function ReasonList({ codes }: { codes: string[] | undefined }) {
  if (!codes || codes.length === 0) return null;
  return (
    <ul className="reason-list">
      {codes.map((code) => (
        <li key={code}>
          <span>{describeReason(code)}</span>
          <code className="meta">{code}</code>
        </li>
      ))}
    </ul>
  );
}

export function Skeleton({ width = "100%", height = 14 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ display: "block", width, height }} aria-hidden />;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state-block">
      <span className="state-icon">{icon}</span>
      <h2 className="card-title">{title}</h2>
      {children ? <p className="muted" style={{ maxWidth: 520 }}>{children}</p> : null}
      {action}
    </div>
  );
}

/** One place that turns an API failure into direction. */
export function ErrorState({ error, onRetry, what }: { error: Error; onRetry?: () => void; what: string }) {
  const api = error instanceof ApiError ? error : undefined;
  if (api?.unreachable) {
    return (
      <div className="state-block danger">
        <span className="state-icon">
          <WifiOff aria-hidden />
        </span>
        <h2 className="card-title">The Intyr API is not reachable</h2>
        <p className="muted" style={{ maxWidth: 520 }}>
          Nothing was sent to a supplier and no payment was requested. Check your connection or the service status, then load {what} again.
        </p>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  if (api?.status === 404) {
    return (
      <div className="state-block">
        <span className="state-icon">
          <CircleHelp aria-hidden />
        </span>
        <h2 className="card-title">Not found</h2>
        <p className="muted" style={{ maxWidth: 520 }}>
          Nothing with this id exists in the current sandbox session. Sessions keep their trips for 24 hours, and each browser has its own session.
        </p>
      </div>
    );
  }
  return (
    <div className="state-block danger">
      <span className="state-icon">
        <AlertTriangle aria-hidden />
      </span>
      <h2 className="card-title">Could not load {what}</h2>
      <p className="muted" style={{ maxWidth: 520 }}>
        {api?.body.reason_codes?.length ? describeReason(api.body.reason_codes[0] ?? "") : error.message}
      </p>
      {api ? <code className="meta">{api.code}</code> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
