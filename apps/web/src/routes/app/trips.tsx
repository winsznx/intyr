import { Link } from "react-router";
import { BedDouble, Car, ChevronRight, CircleDollarSign, ListChecks, Plane } from "lucide-react";
import type { ReactNode } from "react";
import { AppBar } from "../../components/shell";
import { ButtonLink, EmptyState, ErrorState, Ring, Skeleton, TripStateChip } from "../../components/ui";
import { api } from "../../lib/api";
import { formatMoney, relativeTime, shortId } from "../../lib/format";
import { COMPONENT_TYPE, PREPARATION_MODE, describeReason, tripState } from "../../lib/labels";
import type { NextAction, PreparationMode, TripSummary } from "../../lib/types";
import { useResource } from "../../lib/use-resource";

const TYPE_ICON: Record<string, ReactNode> = {
  FLIGHT: <Plane aria-hidden />,
  HOTEL: <BedDouble aria-hidden />,
  GROUND: <Car aria-hidden />,
  TRANSFER: <Car aria-hidden />,
};

const ACTION_TEXT: Record<string, string> = {
  REQUEST_APPROVAL: "Approve before commit",
  COMMIT: "Ready to commit",
  REVALIDATE: "Recheck prices",
  RECOVER: "Run recovery",
  POLL: "Waiting on a supplier",
  VERIFY: "Receipt ready to verify",
  PREPARE: "Prepare legs",
  CHECK: "Check the plan",
  CLOSE: "Nothing left to do",
};

/** Lower sorts first: work that needs a person, then work in progress, then the rest. */
function urgency(trip: TripSummary): number {
  const action = trip.next_action;
  if (trip.state === "MANUAL_REVIEW" || trip.state === "COMMIT_STATUS_UNKNOWN") return 0;
  if (action?.allowed && ["REQUEST_APPROVAL", "RECOVER", "COMMIT"].includes(action.action)) return 1;
  if (tripState(trip.state).running) return 2;
  if (action?.allowed && action.action !== "CLOSE") return 3;
  return 4;
}

function ordered(trips: TripSummary[]): TripSummary[] {
  return [...trips].sort((a, b) => {
    const u = urgency(a) - urgency(b);
    if (u !== 0) return u;
    const da = a.next_action?.deadline ? Date.parse(a.next_action.deadline) : Number.POSITIVE_INFINITY;
    const db = b.next_action?.deadline ? Date.parse(b.next_action.deadline) : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

function needs(action: NextAction | undefined, state: string): string {
  if (state === "COMMIT_STATUS_UNKNOWN") return "Do not retry. Intyr is checking the supplier.";
  if (state === "MANUAL_REVIEW") return "A person has to decide";
  if (!action) return tripState(state).terminal ? "Nothing left to do" : "No action yet";
  if (!action.allowed && action.reason) return describeReason(action.reason);
  return ACTION_TEXT[action.action] ?? action.action;
}

export function TripsPage() {
  const trips = useResource("trips", (signal) => api.listTrips(signal), {
    pollMs: 4000,
    shouldPoll: (list) => Boolean(list?.some((t) => tripState(t.state).running)),
  });

  return (
    <>
      <AppBar crumbs={[{ label: "Trips" }]} end={trips.loading && trips.loaded ? <Ring label="Refreshing" /> : null} />
      <div className="app-content">
        <div className="page-head">
          <div>
            <h1 className="page-title">Trips</h1>
            <p className="muted">Trips in this sandbox session. The one that needs you comes first.</p>
          </div>
          <div className="row">
            <ButtonLink to="/app/trips/new" variant="secondary">
              New trip
            </ButtonLink>
            <ButtonLink to="/app/demo">Run the demo</ButtonLink>
          </div>
        </div>

        <section className="card" aria-label="Trips">
          {!trips.loaded ? (
            <div className="card-pad stack" aria-busy="true">
              <Skeleton height={48} />
              <Skeleton height={48} />
              <Skeleton height={48} />
            </div>
          ) : trips.error && !trips.data ? (
            <ErrorState error={trips.error} onRetry={trips.reload} what="your trips" />
          ) : !trips.data?.length ? (
            <EmptyState
              icon={<ListChecks aria-hidden />}
              title="No trips in this session yet"
              action={
                <div className="row">
                  <ButtonLink to="/app/demo">Run the demo</ButtonLink>
                  <ButtonLink to="/app/trips/new" variant="secondary">
                    New trip
                  </ButtonLink>
                </div>
              }
            >
              The demo runs a three-leg trip where one supplier fails after another has booked, so you can watch Intyr stop, unwind and record every step.
            </EmptyState>
          ) : (
            <ul className="queue">
              {ordered(trips.data).map((trip) => (
                <QueueRow key={trip.trip_id} trip={trip} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function QueueRow({ trip }: { trip: TripSummary }) {
  const deadline = trip.next_action?.deadline && !tripState(trip.state).terminal ? relativeTime(trip.next_action.deadline) : null;
  const urgent = urgency(trip) <= 1;
  return (
    <li>
      <Link to={`/app/trips/${trip.trip_id}`} className="queue-row" data-urgent={urgent || undefined}>
        <span className="queue-state">
          <TripStateChip state={trip.state} />
        </span>
        <span className="queue-main">
          <span className="queue-title">
            {trip.label ?? "Trip"} <span className="mono meta">{shortId(trip.trip_id, 8, 4)}</span>
          </span>
          <span className="queue-legs">
            {trip.components.map((c) => (
              <span key={c.component_id} className="queue-leg" title={`${COMPONENT_TYPE[c.type] ?? c.type}: ${c.preparation_mode ? PREPARATION_MODE[c.preparation_mode as PreparationMode]?.label : "not prepared"}`}>
                {TYPE_ICON[c.type] ?? <CircleDollarSign aria-hidden />}
                {c.preparation_mode ? PREPARATION_MODE[c.preparation_mode as PreparationMode]?.short : ""}
              </span>
            ))}
          </span>
        </span>
        <span className="queue-needs">
          <span>{needs(trip.next_action, trip.state)}</span>
          {deadline ? <span className="meta">{deadline.startsWith("in ") ? `due ${deadline}` : `was due ${deadline}`}</span> : null}
        </span>
        <span className="queue-total num">{trip.total ? formatMoney(trip.total) : ""}</span>
        <ChevronRight className="queue-chevron" aria-hidden />
      </Link>
    </li>
  );
}
