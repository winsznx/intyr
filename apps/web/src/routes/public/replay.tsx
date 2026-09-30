import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, CirclePlay, FileSearch } from "lucide-react";
import type { EvidenceRun } from "../../lib/types";
import { Button, ButtonLink, ErrorState, HashText, Skeleton, cx } from "../../components/ui";
import {
  EnvChip,
  EventType,
  NotProvided,
  SupplierModeChip,
  clockTime,
  elapsed,
  environmentOf,
  fullTime,
  isNotFound,
  labelFromCode,
  orderEvents,
  pick,
  readText,
  useEvidenceRun,
  when,
  type RunEventView,
} from "../../components/proof-parts";

export function ReplayPage() {
  const { runId = "" } = useParams();
  const run = useEvidenceRun(runId);

  return (
    <>
      <div className="pf-replay-banner" role="note">
        <div className="container pf-replay-banner-inner">
          <CirclePlay aria-hidden />
          <p>
            <strong>Captured, not live.</strong> This replays a recorded run. Nothing here is happening now.
          </p>
        </div>
      </div>
      <div className="container section-tight pf-page">
        <Link to={runId ? `/evidence/${encodeURIComponent(runId)}` : "/evidence"} className="pf-back">
          <ArrowLeft aria-hidden />
          Evidence for {runId || "this run"}
        </Link>
        {!run.loaded ? (
          <div className="pf-head" role="status" aria-busy="true">
            <span className="visually-hidden">Loading the recorded run {runId}</span>
            <Skeleton width="min(520px, 100%)" height={40} />
            <Skeleton width="min(320px, 70%)" height={24} />
          </div>
        ) : run.error && isNotFound(run.error) ? (
          <div className="pf-state" role="status">
            <span className="pf-state-icon">
              <FileSearch aria-hidden />
            </span>
            <h1 className="title-m">No recording for {runId} yet</h1>
            <p className="body">The API has no published run with this id, so there is nothing to replay.</p>
            <ButtonLink to="/evidence" variant="secondary">
              See the evidence
            </ButtonLink>
          </div>
        ) : run.error ? (
          <>
            <div className="pf-head">
              <h1 className="title-m">The recording could not be loaded</h1>
            </div>
            <div className="pf-panel" role="status">
              <ErrorState error={run.error} what="this recording" onRetry={run.reload} />
            </div>
          </>
        ) : run.data ? (
          <ReplayPlayer key={runId} runId={runId} run={run.data} />
        ) : null}
      </div>
    </>
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function ReplayPlayer({ runId, run }: { runId: string; run: EvidenceRun }) {
  const source: unknown = run;
  const events = orderEvents(pick(source, "events"));
  const label = readText(pick(source, "label"));
  const manifestId = readText(pick(source, "manifest_id"));
  const environment = pick(source, "environment");
  const supplierMode = readText(pick(source, "supplier_mode"));
  const recordedAt = readText(pick(source, "created_at"));
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const uid = useId();
  const last = events.length - 1;
  const current = events[Math.min(index, Math.max(last, 0))];
  const start = events.find((e) => e.time !== undefined)?.time;

  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(last, next));
    setIndex(clamped);
    const list = listRef.current;
    if (list && list.contains(document.activeElement)) {
      list.querySelector<HTMLButtonElement>(`[data-step="${clamped}"]`)?.focus();
    }
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isEditable(event.target)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveRef.current(indexRef.current - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveRef.current(indexRef.current + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onListKey = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(last);
    }
  };

  const header = (
    <header className="pf-head">
      <p className="pf-eyebrow">{readText(pick(source, "run_id")) ?? runId}</p>
      <h1 className="title-l">Replay of {label ?? runId}</h1>
      <div className="pf-meta">
        {environmentOf(environment) ? <EnvChip environment={environment} /> : null}
        {supplierMode ? <SupplierModeChip mode={supplierMode} /> : null}
        {recordedAt ? <span className="meta">Recorded {when(recordedAt)}</span> : null}
      </div>
      {manifestId ? (
        <p className="small">
          <Link className="link" to={`/verify/${encodeURIComponent(manifestId)}`}>
            Verify the manifest this run produced
          </Link>
        </p>
      ) : null}
    </header>
  );

  if (!current) {
    return (
      <>
        {header}
        <div className="pf-panel" role="status">
          <p className="pf-empty">This run has no recorded events, so there is nothing to step through.</p>
        </div>
      </>
    );
  }

  const position = Math.min(index, last);
  const atStart = position === 0;
  const atEnd = position === last;
  const progress = events.length > 1 ? (position / last) * 100 : 100;

  return (
    <>
      {header}
      <div className="pf-replay">
        <section className="pf-stage" aria-labelledby={`${uid}-stage`}>
          <div className="pf-stage-live" role="status" aria-live="polite" aria-atomic="true">
            <p className="pf-stage-count">
              Step {position + 1} of {events.length}
            </p>
            <h2 id={`${uid}-stage`} className="pf-stage-title">
              <EventType type={current.type} />
            </h2>
            <StepFacts event={current} start={start} />
          </div>

          <div className="pf-controls">
            <Button variant="secondary" onClick={() => move(position - 1)} aria-disabled={atStart || undefined} aria-label="Previous step">
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <span className="pf-progress" aria-hidden>
              <span style={{ width: `${progress}%` }} />
            </span>
            <Button onClick={() => move(position + 1)} aria-disabled={atEnd || undefined} aria-label="Next step">
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
          <p className="meta pf-keys">
            Use <kbd>←</kbd> and <kbd>→</kbd> to step. In the list, <kbd>Home</kbd> and <kbd>End</kbd> jump to the first and last step.
          </p>
        </section>

        <nav className="pf-steps-nav" aria-label="Recorded steps">
          <ol ref={listRef} className="pf-step-list" onKeyDown={onListKey}>
            {events.map((event, i) => (
              <li key={`${event.index}-${event.at ?? ""}`}>
                <button
                  type="button"
                  data-step={i}
                  className={cx("pf-step", i < position && "is-done", i === position && "is-current")}
                  aria-current={i === position ? "step" : undefined}
                  onClick={() => move(i)}
                >
                  <span className="pf-step-num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="pf-step-name">{event.type ? labelFromCode(event.type) : "Event type not provided"}</span>
                  <span className="pf-step-time">{offsetOf(event, start) ?? clockTime(event.at)}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </>
  );
}

function offsetOf(event: RunEventView, start: number | undefined): string | undefined {
  if (event.time === undefined || start === undefined) return undefined;
  return elapsed(event.time - start);
}

function StepFacts({ event, start }: { event: RunEventView; start: number | undefined }) {
  const offset = offsetOf(event, start);
  return (
    <dl className="kv pf-kv">
      <dt>Recorded at</dt>
      <dd>{event.at ? <time dateTime={event.at}>{fullTime(event.at)}</time> : <NotProvided />}</dd>
      <dt>Since first event</dt>
      <dd className="mono num">{offset ?? <NotProvided />}</dd>
      <dt>Detail</dt>
      <dd>{event.detail ?? <NotProvided />}</dd>
      <dt>Event hash</dt>
      <dd>{event.hash ? <HashText value={event.hash} label="event hash" /> : <span className="pf-missing">No hash recorded for this event</span>}</dd>
    </dl>
  );
}
