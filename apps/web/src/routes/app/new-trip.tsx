import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ActionResult, type ActionOutcome } from "../../components/action-result";
import { AppBar } from "../../components/shell";
import { Button, Notice } from "../../components/ui";
import { api, type ActionResponse } from "../../lib/api";
import type { CheckRequest, ComponentRequest, TripIntent } from "../../lib/types";

type Mode = "prepare" | "check";

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function isoInHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const CHECK_EXAMPLE: CheckRequest = {
  trip_ref: "my-agent-trip",
  currency: "USD",
  limits: { max_total_minor: 150_000, max_irreversible_minor: 80_000 },
  legs: [
    {
      leg_id: "hotel",
      type: "HOTEL",
      supplier: "example-hotel-api",
      offer_ref: "offer-123",
      price: { amount_minor: 42_000, currency: "USD" },
      preparation_mode: "REVALIDATED",
      refundable: true,
      clocks: { price_valid_until: isoInHours(1), free_cancel_until: isoInHours(72), refund_destination: "CASH", confirmation_mode: "INSTANT" },
    },
    {
      leg_id: "flight",
      type: "FLIGHT",
      supplier: "example-airline-api",
      offer_ref: "off_abc",
      price: { amount_minor: 61_000, currency: "USD" },
      preparation_mode: "INSTANT_COMMIT_ONLY",
      refundable: false,
      clocks: { price_valid_until: isoInHours(0.4), refund_destination: "NONE", confirmation_mode: "ASYNC" },
    },
  ],
};

interface Fields {
  tripRef: string;
  flight: boolean;
  origin: string;
  destination: string;
  departDate: string;
  passengers: number;
  hold: boolean;
  hotel: boolean;
  city: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  ground: boolean;
  from: string;
  to: string;
  pickupAt: string;
  budget: string;
  currency: "EUR" | "USD";
  maxMove: string;
}

const INITIAL: Fields = {
  tripRef: "",
  flight: true,
  origin: "LHR",
  destination: "JFK",
  departDate: isoDate(21),
  passengers: 1,
  hold: false,
  hotel: true,
  city: "New York",
  checkIn: isoDate(21),
  checkOut: isoDate(23),
  guests: 1,
  ground: false,
  from: "JFK",
  to: "Midtown Manhattan",
  pickupAt: `${isoDate(21)}T14:30`,
  budget: "2500",
  currency: "EUR",
  maxMove: "2",
};

function validate(f: Fields): Record<string, string> {
  const errors: Record<string, string> = {};
  const today = isoDate(0);
  if (!f.flight && !f.hotel && !f.ground) errors.components = "Add at least one leg.";
  if (f.flight) {
    if (!/^[A-Z]{3}$/.test(f.origin)) errors.origin = "Use a three-letter airport code, for example LHR.";
    if (!/^[A-Z]{3}$/.test(f.destination)) errors.destination = "Use a three-letter airport code, for example LIS.";
    if (f.origin === f.destination) errors.destination = "Origin and destination must differ.";
    if (!f.departDate || f.departDate <= today) errors.departDate = "Pick a date after today.";
  }
  if (f.hotel) {
    if (f.city.trim().length < 2) errors.city = "Enter a city.";
    if (!f.checkIn || f.checkIn <= today) errors.checkIn = "Pick a date after today.";
    if (!f.checkOut || f.checkOut <= f.checkIn) errors.checkOut = "Check-out must be after check-in.";
  }
  if (f.ground) {
    if (f.from.trim().length < 2) errors.from = "Enter a pickup place.";
    if (f.to.trim().length < 2) errors.to = "Enter a drop-off place.";
    if (!f.pickupAt || new Date(f.pickupAt).getTime() <= Date.now()) errors.pickupAt = "Pick a time in the future.";
  }
  const budget = Number(f.budget);
  if (!Number.isFinite(budget) || budget <= 0) errors.budget = "Enter a budget above zero.";
  const move = Number(f.maxMove);
  if (!Number.isFinite(move) || move < 0 || move > 100) errors.maxMove = "Enter a percentage between 0 and 100.";
  return errors;
}

function toIntent(f: Fields): TripIntent {
  const components: ComponentRequest[] = [];
  if (f.hotel) components.push({ type: "HOTEL", city: f.city.trim(), check_in: f.checkIn, check_out: f.checkOut, guests: f.guests });
  if (f.ground) components.push({ type: "GROUND", from: f.from.trim(), to: f.to.trim(), pickup_at: new Date(f.pickupAt).toISOString().replace(/\.\d{3}Z$/, "Z"), passengers: f.passengers });
  if (f.flight) components.push({ type: "FLIGHT", origin: f.origin, destination: f.destination, depart_date: f.departDate, passengers: f.passengers, hold_if_available: f.hold });
  const budgetMinor = Math.round(Number(f.budget) * 100);
  return {
    ...(f.tripRef.trim() ? { trip_ref: f.tripRef.trim() } : {}),
    currency: f.currency,
    budget_total_minor: budgetMinor,
    components,
    limits: { max_total_minor: budgetMinor, max_price_move_pct: Number(f.maxMove) },
  };
}

export function NewTripPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("prepare");
  const [fields, setFields] = useState<Fields>(INITIAL);
  const [checkJson, setCheckJson] = useState(() => JSON.stringify(CHECK_EXAMPLE, null, 2));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const errors = useMemo(() => validate(fields), [fields]);
  const jsonError = useMemo(() => {
    try {
      const parsed = JSON.parse(checkJson) as Partial<CheckRequest>;
      if (!Array.isArray(parsed.legs) || parsed.legs.length === 0) return "The request needs a non-empty legs array.";
      if (typeof parsed.currency !== "string") return "The request needs a currency, for example USD.";
      return null;
    } catch (error) {
      return error instanceof Error ? `Not valid JSON: ${error.message}` : "Not valid JSON.";
    }
  }, [checkJson]);

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }));
  const show = (key: string) => (submitted ? errors[key] : undefined);

  const finish = (response: ActionResponse, action: string) => {
    const tripId = response.trip_id ?? response.trip?.trip_id;
    if (tripId) navigate(`/app/trips/${tripId}`);
    else setOutcome({ ok: true, action, response });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setOutcome(null);
    if (mode === "prepare" && Object.keys(errors).length > 0) return;
    if (mode === "check" && jsonError) return;
    setBusy(true);
    try {
      if (mode === "prepare") finish(await api.prepareTrip(toIntent(fields)), "PREPARE");
      else finish(await api.checkTrip(JSON.parse(checkJson) as CheckRequest), "CHECK");
    } catch (error) {
      setOutcome({ ok: false, action: mode.toUpperCase(), error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AppBar crumbs={[{ label: "Trips", to: "/app" }, { label: "New trip" }]} />
      <form className="app-content stack-lg" onSubmit={(e) => void submit(e)} noValidate>
        <div className="page-head">
          <div>
            <h1 className="page-title">New trip</h1>
            <p className="muted">Nothing is booked here. Preparing asks each supplier for a current price and returns a signed manifest you can review before committing.</p>
          </div>
          <div className="segmented" role="group" aria-label="How to start">
            <button type="button" aria-pressed={mode === "prepare"} onClick={() => setMode("prepare")}>
              Prepare with suppliers
            </button>
            <button type="button" aria-pressed={mode === "check"} onClick={() => setMode("check")}>
              Check offers I already have
            </button>
          </div>
        </div>

        {mode === "prepare" ? (
          <>
            <Notice kind="info" title="Supplier test mode.">
              Flights come from Duffel in test mode and hotels from LiteAPI's sandbox, priced in EUR. Ground transfers use a simulator, because no ground
              supplier offers a sandbox without a contract. Real test offers score below the readiness bar, so you approve them before Intyr commits, and
              a commit can take a minute because supplier test systems are slow. The failure scenarios on the demo page run on the simulator.
            </Notice>
            {show("components") ? <p className="field-error">{errors.components}</p> : null}

            <fieldset className="card form-card">
              <legend className="visually-hidden">Flight</legend>
              <label className="leg-toggle">
                <input type="checkbox" checked={fields.flight} onChange={(e) => set("flight", e.target.checked)} />
                <span className="card-title">Flight</span>
              </label>
              {fields.flight ? (
                <div className="form-grid">
                  <Field label="From" error={show("origin")} hint="Airport code">
                    <input className="input" value={fields.origin} maxLength={3} onChange={(e) => set("origin", e.target.value.toUpperCase())} aria-invalid={Boolean(show("origin"))} />
                  </Field>
                  <Field label="To" error={show("destination")} hint="Airport code">
                    <input className="input" value={fields.destination} maxLength={3} onChange={(e) => set("destination", e.target.value.toUpperCase())} aria-invalid={Boolean(show("destination"))} />
                  </Field>
                  <Field label="Departure" error={show("departDate")}>
                    <input className="input" type="date" value={fields.departDate} onChange={(e) => set("departDate", e.target.value)} aria-invalid={Boolean(show("departDate"))} />
                  </Field>
                  <Field label="Passengers">
                    <input className="input" type="number" min={1} max={9} value={fields.passengers} onChange={(e) => set("passengers", Math.max(1, Math.min(9, Number(e.target.value) || 1)))} />
                  </Field>
                  <label className="check-row wide">
                    <input type="checkbox" checked={fields.hold} onChange={(e) => set("hold", e.target.checked)} />
                    <span>
                      Ask the airline for a hold when it offers one. <span className="muted">Only a few airlines hold, and suppliers limit holds that never become bookings.</span>
                    </span>
                  </label>
                </div>
              ) : null}
            </fieldset>

            <fieldset className="card form-card">
              <legend className="visually-hidden">Hotel</legend>
              <label className="leg-toggle">
                <input type="checkbox" checked={fields.hotel} onChange={(e) => set("hotel", e.target.checked)} />
                <span className="card-title">Hotel</span>
              </label>
              {fields.hotel ? (
                <div className="form-grid">
                  <Field label="City" error={show("city")}>
                    <input className="input" value={fields.city} onChange={(e) => set("city", e.target.value)} aria-invalid={Boolean(show("city"))} />
                  </Field>
                  <Field label="Check-in" error={show("checkIn")}>
                    <input className="input" type="date" value={fields.checkIn} onChange={(e) => set("checkIn", e.target.value)} aria-invalid={Boolean(show("checkIn"))} />
                  </Field>
                  <Field label="Check-out" error={show("checkOut")}>
                    <input className="input" type="date" value={fields.checkOut} onChange={(e) => set("checkOut", e.target.value)} aria-invalid={Boolean(show("checkOut"))} />
                  </Field>
                  <Field label="Guests">
                    <input className="input" type="number" min={1} max={8} value={fields.guests} onChange={(e) => set("guests", Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
                  </Field>
                </div>
              ) : null}
            </fieldset>

            <fieldset className="card form-card">
              <legend className="visually-hidden">Ground transfer</legend>
              <label className="leg-toggle">
                <input type="checkbox" checked={fields.ground} onChange={(e) => set("ground", e.target.checked)} />
                <span className="card-title">Ground transfer</span>
                <span className="meta">Simulated</span>
              </label>
              {fields.ground ? (
                <div className="form-grid">
                  <Field label="Pickup" error={show("from")}>
                    <input className="input" value={fields.from} onChange={(e) => set("from", e.target.value)} aria-invalid={Boolean(show("from"))} />
                  </Field>
                  <Field label="Drop-off" error={show("to")}>
                    <input className="input" value={fields.to} onChange={(e) => set("to", e.target.value)} aria-invalid={Boolean(show("to"))} />
                  </Field>
                  <Field label="Pickup time" error={show("pickupAt")} hint="Your local time">
                    <input className="input" type="datetime-local" value={fields.pickupAt} onChange={(e) => set("pickupAt", e.target.value)} aria-invalid={Boolean(show("pickupAt"))} />
                  </Field>
                </div>
              ) : null}
            </fieldset>

            <fieldset className="card form-card">
              <legend className="card-title">Limits</legend>
              <div className="form-grid">
                <Field label={`Budget in ${fields.currency}`} error={show("budget")} hint="Intyr refuses to commit above this. Duffel's test mode prices in EUR.">
                  <input className="input" inputMode="decimal" value={fields.budget} onChange={(e) => set("budget", e.target.value)} aria-invalid={Boolean(show("budget"))} />
                </Field>
                <Field label="Largest price move allowed, in percent" error={show("maxMove")} hint="A bigger move needs a recheck and an approval.">
                  <input className="input" inputMode="decimal" value={fields.maxMove} onChange={(e) => set("maxMove", e.target.value)} aria-invalid={Boolean(show("maxMove"))} />
                </Field>
                <Field label="Your reference (optional)">
                  <input className="input" value={fields.tripRef} maxLength={64} onChange={(e) => set("tripRef", e.target.value)} />
                </Field>
              </div>
            </fieldset>
          </>
        ) : (
          <section className="card form-card">
            <h2 className="card-title">Offers your agent already found</h2>
            <p className="muted">
              Paste the legs as JSON. Intyr does not call any supplier in this mode. It returns a signed plan with the commit order, how firm each leg is,
              how much would be stuck if a leg fails, and whether it is safe to commit. Legs you describe are labeled as reported by the agent.
            </p>
            <label className="field">
              <span className="field-label">Check request</span>
              <textarea className="textarea" rows={22} spellCheck={false} value={checkJson} onChange={(e) => setCheckJson(e.target.value)} aria-invalid={Boolean(submitted && jsonError)} />
              {submitted && jsonError ? <span className="field-error">{jsonError}</span> : <span className="field-hint">Same body as POST /v1/trips/check.</span>}
            </label>
          </section>
        )}

        <ActionResult outcome={outcome} />

        <div className="row form-actions">
          <Button type="submit" size="lg" loading={busy}>
            {mode === "prepare" ? "Prepare trip" : "Check the plan"}
          </Button>
          <span className="meta">In the sandbox the service fee is sponsored. No USDC moves and you are not charged.</span>
        </div>
      </form>
    </>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
