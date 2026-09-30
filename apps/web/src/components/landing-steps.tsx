import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BedDouble, Car, Lock, Plane, RotateCcw } from "lucide-react";
import { PREPARATION_MODE } from "../lib/labels";
import { Chip, ComponentStateChip, DecisionChip, TripStateChip } from "./ui";

interface Leg {
  key: string;
  icon: ReactNode;
  name: string;
  source: string;
}

/** The same illustrative trip as the landing hero, in commit order. */
const LEGS: Leg[] = [
  { key: "hotel", icon: <BedDouble aria-hidden />, name: "Hotel", source: "LiteAPI, test mode" },
  { key: "transfer", icon: <Car aria-hidden />, name: "Airport transfer", source: "Seeded simulator" },
  { key: "flight", icon: <Plane aria-hidden />, name: "Flight", source: "Duffel, test mode" },
];

interface Step {
  id: string;
  title: string;
  summary: string;
  route: string;
  heading: string;
  /** One status per leg, in the order of LEGS. */
  statuses: [ReactNode, ReactNode, ReactNode];
  outcome: ReactNode;
  outcomeText: string;
}

const STEPS: Step[] = [
  {
    id: "check",
    title: "Check",
    summary:
      "Send the legs your agent found. Intyr puts the legs that can be undone first and the one that cannot last, and returns a verdict before anything is booked.",
    route: "POST /v1/trips/check",
    heading: "A commit order and a verdict",
    statuses: [
      <Chip key="h" tone="outline" icon={<RotateCcw aria-hidden />}>
        Can be undone
      </Chip>,
      <Chip key="t" tone="outline" icon={<RotateCcw aria-hidden />}>
        Can be undone
      </Chip>,
      <Chip key="f" tone="neutral" icon={<Lock aria-hidden />}>
        Cannot be undone
      </Chip>,
    ],
    outcome: <DecisionChip outcome="ACT" />,
    outcomeText: "Verdict COMMIT_NOW. The flight goes last because it cannot be undone.",
  },
  {
    id: "prepare",
    title: "Prepare",
    summary: "Intyr asks each supplier to hold or reprice its leg, records how firm each hold is and signs a manifest of exactly what will be booked.",
    route: "POST /v1/trips/prepare",
    heading: "A signed manifest of each leg",
    statuses: [
      <Chip key="h" tone="outline">
        {PREPARATION_MODE.SOFT_HOLD.label}
      </Chip>,
      <Chip key="t" tone="outline">
        {PREPARATION_MODE.REVALIDATED.label}
      </Chip>,
      <Chip key="f" tone="outline">
        {PREPARATION_MODE.INSTANT_COMMIT_ONLY.label}
      </Chip>,
    ],
    outcome: <TripStateChip state="PREPARED" />,
    outcomeText: "The manifest fixes each leg, price and hold before any money moves.",
  },
  {
    id: "commit",
    title: "Commit",
    summary:
      "Legs are booked in order. A timeout counts as unknown and the supplier is read before any retry, and a reply only counts once a second read confirms it.",
    route: "POST /v1/trips/commit",
    heading: "Confirmed only after a second read",
    statuses: [
      <ComponentStateChip key="h" state="CONFIRMED" />,
      <ComponentStateChip key="t" state="CONFIRMED" />,
      <ComponentStateChip key="f" state="COMMIT_STATUS_UNKNOWN" />,
    ],
    outcome: <DecisionChip outcome="UNKNOWN" />,
    outcomeText: "The flight timed out. Intyr reads the supplier before it retries anything.",
  },
  {
    id: "recover",
    title: "Recover",
    summary: "If a leg fails, Intyr cancels or replaces what can be undone, only inside the limits set before payment, and reports what it could not fix.",
    route: "POST /v1/trips/recover",
    heading: "Unwound inside your limits",
    statuses: [
      <ComponentStateChip key="h" state="CANCELLED" />,
      <ComponentStateChip key="t" state="CANCELLED" />,
      <ComponentStateChip key="f" state="COMMIT_FAILED" />,
    ],
    outcome: <TripStateChip state="RECOVERED" />,
    outcomeText: "The flight was never booked, so the hotel and transfer were cancelled.",
  },
];

const KEY_STEP: Record<string, (current: number, last: number) => number> = {
  ArrowDown: (current, last) => (current === last ? 0 : current + 1),
  ArrowRight: (current, last) => (current === last ? 0 : current + 1),
  ArrowUp: (current, last) => (current === 0 ? last : current - 1),
  ArrowLeft: (current, last) => (current === 0 ? last : current - 1),
  Home: () => 0,
  End: (_, last) => last,
};

/** Numbered step list (reference S2). Selecting a step shows the example trip at that step. */
export function LandingSteps() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const step = STEPS[active] ?? STEPS[0]!;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = KEY_STEP[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(active, STEPS.length - 1);
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="lp-steps">
      <div className="lp-step-list" role="tablist" aria-label="How Intyr handles a trip" aria-orientation="vertical" onKeyDown={onKeyDown}>
        {STEPS.map((s, index) => {
          const selected = index === active;
          return (
            <button
              key={s.id}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`lp-step-${s.id}`}
              className="lp-step"
              aria-selected={selected}
              aria-controls="lp-step-panel"
              aria-labelledby={`lp-step-${s.id}-title`}
              aria-describedby={`lp-step-${s.id}-summary`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
            >
              <span className="lp-step-num mono" aria-hidden>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="lp-step-text">
                <span className="lp-step-title" id={`lp-step-${s.id}-title`}>
                  {s.title}
                </span>
                <span className="lp-step-summary" id={`lp-step-${s.id}-summary`}>
                  {s.summary}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="lp-step-panel" role="tabpanel" id="lp-step-panel" aria-labelledby={`lp-step-${step.id}`} tabIndex={0}>
        <div className="lp-step-panel-head">
          <code className="lp-step-route">{step.route}</code>
          <h3 className="title-s">{step.heading}</h3>
        </div>
        <ol className="lp-legs">
          {LEGS.map((leg, index) => (
            <li key={leg.key} className="lp-leg">
              <span className="rail-order mono" aria-hidden>
                {index + 1}
              </span>
              <span className="rail-icon" aria-hidden>
                {leg.icon}
              </span>
              <span className="lp-leg-name">
                <span className="lp-leg-title">{leg.name}</span>
                <span className="lp-leg-source">{leg.source}</span>
              </span>
              <span className="lp-leg-status">{step.statuses[index]}</span>
            </li>
          ))}
        </ol>
        <div className="lp-step-outcome">
          {step.outcome}
          <span>{step.outcomeText}</span>
        </div>
        <p className="lp-step-note">Illustration with test-mode and simulated suppliers.</p>
      </div>
    </div>
  );
}
