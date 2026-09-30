import { useState } from "react";
import { useNavigate } from "react-router";
import { ActionResult, type ActionOutcome } from "../../components/action-result";
import { AppBar } from "../../components/shell";
import { Button, ErrorState, Notice, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { SCENARIOS, scenarioIntent, type ScenarioPreset } from "../../lib/scenarios";
import { useResource } from "../../lib/use-resource";

/** Plain-language setup for the scenarios the server runs end to end. Unknown ids fall back to the server label. */
const SERVER_SCENARIO_TEXT: Record<string, { setup: string; expect: string }> = {
  happy: {
    setup: "Every simulated supplier behaves normally.",
    expect: "All three legs are committed and read back before the trip is called committed.",
  },
  "rejected-flight": {
    setup: "The hotel and the transfer confirm, then the airline rejects the flight.",
    expect: "Intyr cancels the hotel and the transfer inside their free windows and leaves nothing stranded.",
  },
  "timeout-hotel": {
    setup: "The hotel booking times out, and the hotel did create the booking.",
    expect: "The hotel is marked unknown and never retried. About a minute later a supplier read finds the booking and the trip becomes committed. Keep the trip page open to watch it change.",
  },
  "refuse-irreversible": {
    setup: "One leg cannot be cancelled or refunded, and it is priced above the limit for money that cannot be undone.",
    expect: "Intyr refuses to commit and books nothing.",
  },
};

export function DemoPage() {
  const navigate = useNavigate();
  const scenarios = useResource("demo-scenarios", (signal) => api.getDemoScenarios(signal));
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const runEndToEnd = async (id: string) => {
    setBusy(`run:${id}`);
    setOutcome(null);
    try {
      const run = await api.runDemo(id);
      navigate(`/app/trips/${run.trip_id}`);
    } catch (error) {
      setOutcome({ ok: false, action: "DEMO", error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      setBusy(null);
    }
  };

  const prepare = async (preset: ScenarioPreset) => {
    setBusy(`prep:${preset.id}`);
    setOutcome(null);
    try {
      const response = await api.prepareTrip(scenarioIntent(preset));
      const tripId = response.trip_id ?? response.trip?.trip_id;
      if (tripId) {
        navigate(`/app/trips/${tripId}`);
        return;
      }
      setOutcome({ ok: true, action: "PREPARE", response });
    } catch (error) {
      setOutcome({ ok: false, action: "PREPARE", error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <AppBar crumbs={[{ label: "Trips", to: "/app" }, { label: "Run the demo" }]} />
      <div className="app-content stack-lg">
        <div className="page-head">
          <div>
            <h1 className="page-title">Run a trip that goes wrong</h1>
            <p className="muted">
              Each scenario books a Lisbon trip with a hotel, an airport transfer and a flight. A seeded simulator plays the suppliers, so the same failure
              happens every time and you can see what Intyr decided at each step, including the steps where it did nothing.
            </p>
          </div>
        </div>

        <Notice kind="info" title="Simulated suppliers, sponsored fees.">
          The suppliers here are simulated and every leg is labeled that way in the trip and its receipt. In the sandbox the x402 service fee is
          sponsored, so no USDC moves. The same routes under /v1 charge a real payment on Algorand Mainnet.
        </Notice>

        <ActionResult outcome={outcome} />

        <section className="stack" aria-labelledby="auto-title">
          <div>
            <h2 className="card-title" id="auto-title">
              Run end to end
            </h2>
            <p className="muted small">The server prepares and commits in one go, then opens the trip so you can read what happened.</p>
          </div>
          {!scenarios.loaded ? (
            <div className="stack" aria-busy="true">
              <Skeleton height={88} />
              <Skeleton height={88} />
            </div>
          ) : scenarios.error ? (
            <div className="card">
              <ErrorState error={scenarios.error} onRetry={scenarios.reload} what="the demo scenarios" />
            </div>
          ) : (
            <ol className="scenario-list">
              {(scenarios.data ?? []).map((scenario, i) => {
                const text = SERVER_SCENARIO_TEXT[scenario.id];
                return (
                  <li key={scenario.id} className="scenario">
                    <span className="scenario-index mono">{String(i + 1).padStart(2, "0")}</span>
                    <div className="scenario-body">
                      <h3 className="card-title">{scenario.label}</h3>
                      {text ? (
                        <dl className="scenario-facts">
                          <div>
                            <dt>What the suppliers do</dt>
                            <dd>{text.setup}</dd>
                          </div>
                          <div>
                            <dt>What Intyr should do</dt>
                            <dd>{text.expect}</dd>
                          </div>
                        </dl>
                      ) : null}
                    </div>
                    <Button onClick={() => void runEndToEnd(scenario.id)} loading={busy === `run:${scenario.id}`} disabled={busy !== null && busy !== `run:${scenario.id}`}>
                      Run it
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="stack" aria-labelledby="step-title">
          <div>
            <h2 className="card-title" id="step-title">
              Step through it yourself
            </h2>
            <p className="muted small">Intyr prepares the trip and stops. You review the legs and press commit.</p>
          </div>
          <ol className="scenario-list">
            {SCENARIOS.map((preset) => (
              <li key={preset.id} className="scenario scenario-compact">
                <div className="scenario-body">
                  <h3 className="card-title">{preset.title}</h3>
                  <p className="muted small">{preset.setup}</p>
                </div>
                <Button variant="secondary" onClick={() => void prepare(preset)} loading={busy === `prep:${preset.id}`} disabled={busy !== null && busy !== `prep:${preset.id}`}>
                  Prepare
                </Button>
              </li>
            ))}
          </ol>
        </section>

        <p className="meta">What Intyr should do is a prediction. The trip page shows what the server actually recorded.</p>
      </div>
    </>
  );
}
