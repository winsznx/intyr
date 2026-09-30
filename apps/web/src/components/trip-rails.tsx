import { BedDouble, Car, CircleDollarSign, Plane, Smartphone, TrainFront, Ticket, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { COMPONENT_TYPE, EVIDENCE_GRADE, LEG_CLASS, PREPARATION_MODE, componentState } from "../lib/labels";
import { formatMoney, relativeTime } from "../lib/format";
import type { ComponentState, TripComponent } from "../lib/types";
import { Chip, ComponentStateChip, cx } from "./ui";

const TYPE_ICON: Record<string, ReactNode> = {
  FLIGHT: <Plane aria-hidden />,
  HOTEL: <BedDouble aria-hidden />,
  GROUND: <Car aria-hidden />,
  TRANSFER: <Car aria-hidden />,
  RAIL: <TrainFront aria-hidden />,
  EVENT: <Ticket aria-hidden />,
  ESIM: <Smartphone aria-hidden />,
};

const PRE_COMMIT: ComponentState[] = ["REQUESTED", "PREPARING", "PREPARED", "PRICE_UNCERTAIN", "UNAVAILABLE", "EXPIRED"];

/** How far the rail has travelled past the commit boundary, as a visual state. */
function postState(c: TripComponent): string {
  if (PRE_COMMIT.includes(c.state)) return "idle";
  switch (c.state) {
    case "COMMIT_SUBMITTED":
    case "COMMIT_RESPONDED":
      return "moving";
    case "CONFIRMED":
      return c.outcome_verification === "CONTRADICTED" ? "contradicted" : "confirmed";
    case "COMMIT_STATUS_UNKNOWN":
      return "unknown";
    case "COMMIT_FAILED":
      return "failed";
    case "CANCELLING":
      return "cancelling";
    case "CANCELLED":
      return "cancelled";
    case "RECOVERY_PENDING":
      return "pending";
    case "REPLACED":
      return "replaced";
    default:
      return "idle";
  }
}

function preState(c: TripComponent): string {
  if (c.state === "REQUESTED") return "none";
  if (c.state === "PREPARING") return "loading";
  if (c.state === "UNAVAILABLE") return "unavailable";
  if (c.state === "EXPIRED") return "expired";
  return (c.preparation_mode ?? "REVALIDATED").toLowerCase().replace(/_/g, "-");
}

function clockLine(c: TripComponent): string | null {
  const phrase = (iso: string | null | undefined, open: string, closed: string) => {
    const rel = iso ? relativeTime(iso) : null;
    if (!rel) return null;
    return rel.startsWith("in ") ? `${open} for ${rel.slice(3)}` : `${closed} ${rel}`;
  };
  const parts = [
    phrase(c.inventory_held_until, "Held", "Hold ended"),
    phrase(c.price_valid_until, "Price valid", "Price expired"),
    phrase(c.free_cancel_until, "Free cancellation", "Free cancellation ended"),
  ].filter((p): p is string => Boolean(p));
  return parts.length ? `${parts.join(". ")}.` : null;
}

export function TripRails({
  components,
  caption,
  compact,
  showClocks = true,
}: {
  components: TripComponent[];
  caption?: ReactNode;
  compact?: boolean;
  /** Clocks are relative to now, so they are hidden once a trip is finished. */
  showClocks?: boolean;
}) {
  const ordered = [...components].sort((a, b) => (a.commit_order ?? 99) - (b.commit_order ?? 99));
  const hasOrder = ordered.some((c) => typeof c.commit_order === "number");

  return (
    <figure className={cx("rails", compact && "rails-compact")}>
      <div className="rails-head" aria-hidden>
        <span />
        <span>Prepared</span>
        <span className="rails-boundary-label" data-label="Commit boundary" />
        <span>Outcome</span>
        <span />
      </div>
      <ol className="rails-list">
        {ordered.map((c, index) => {
          const mode = c.preparation_mode ? PREPARATION_MODE[c.preparation_mode] : undefined;
          const post = postState(c);
          const pre = preState(c);
          const clocks = compact || !showClocks ? null : clockLine(c);
          const state = componentState(c.state);
          return (
            <li key={c.component_id} className="rail-row" data-role="rail" data-state={c.state} data-post={post} data-pre={pre} data-irreversible={c.irreversible || undefined}>
              <div className="rail-label">
                {hasOrder ? (
                  <span className="rail-order mono" title="Commit order">
                    {c.commit_order ?? index + 1}
                  </span>
                ) : null}
                <span className="rail-icon">{TYPE_ICON[c.type] ?? <CircleDollarSign aria-hidden />}</span>
                <span className="rail-name">
                  <span className="rail-title">{c.label ?? COMPONENT_TYPE[c.type] ?? c.type}</span>
                  <span className="rail-sub">
                    {[c.supplier, c.leg_class ? LEG_CLASS[c.leg_class] : undefined].filter(Boolean).join(", ")}
                  </span>
                </span>
              </div>

              <div className="rail-track rail-pre" title={mode?.explain}>
                <span className="rail-bar" />
                <span className="rail-node" />
              </div>
              <div className="rail-boundary" data-role="commit-boundary" aria-hidden />
              <div className="rail-track rail-post">
                <span className="rail-bar" />
                <span className="rail-end">
                  {post === "unknown" ? "?" : null}
                  {post === "moving" || post === "cancelling" ? <span className="rail-ring" /> : null}
                </span>
              </div>

              <div className="rail-status">
                <ComponentStateChip state={c.state} />
                <span className="rail-price num">{c.price ? formatMoney(c.price) : ""}</span>
              </div>

              <p className="visually-hidden">
                {`${c.label ?? c.type}: ${mode?.label ?? "not prepared"}, ${state.label}${c.irreversible ? ", cannot be undone" : ""}.`}
              </p>

              {!compact ? (
                <div className="rail-detail">
                  {mode ? <span className="rail-mode">{mode.label}.</span> : null}
                  {clocks ? <span>{clocks}</span> : null}
                  {c.irreversible ? <span className="rail-irrev">Cannot be undone once booked</span> : null}
                  {c.evidence_grade ? (
                    <Chip tone={EVIDENCE_GRADE[c.evidence_grade].tone}>{EVIDENCE_GRADE[c.evidence_grade].label}</Chip>
                  ) : null}
                  {c.replaces ? (
                    <span className="rail-branch">
                      <GitBranch aria-hidden /> Replaces an earlier leg
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {caption ? <figcaption className="rails-caption">{caption}</figcaption> : null}
    </figure>
  );
}

export function RailsLegend() {
  return (
    <dl className="rails-legend">
      <div data-key="hard-hold">
        <dt>
          <span className="lg lg-hold" />
        </dt>
        <dd>Held by the supplier</dd>
      </div>
      <div data-key="revalidated">
        <dt>
          <span className="lg lg-checked" />
        </dt>
        <dd>Price checked, not held</dd>
      </div>
      <div data-key="instant">
        <dt>
          <span className="lg lg-instant" />
        </dt>
        <dd>Booked only at commit</dd>
      </div>
      <div data-key="confirmed">
        <dt>
          <span className="lg lg-confirmed" />
        </dt>
        <dd>Confirmed by a second read</dd>
      </div>
      <div data-key="unknown">
        <dt>
          <span className="lg lg-unknown" />
        </dt>
        <dd>Not confirmed either way</dd>
      </div>
      <div data-key="failed">
        <dt>
          <span className="lg lg-failed" />
        </dt>
        <dd>Failed or unwound</dd>
      </div>
      <div data-key="irreversible">
        <dt>
          <span className="lg lg-irrev" />
        </dt>
        <dd>Cannot be undone, committed last</dd>
      </div>
    </dl>
  );
}
