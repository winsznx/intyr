import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { FileCheck2, FlaskConical, ListChecks, Menu, PlayCircle, Plus, ScrollText, X } from "lucide-react";
import { ensureSandboxSession } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { SandboxSession } from "../lib/types";
import { ButtonLink, cx } from "./ui";

export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#0C0C0C" />
      <path d="M9 11h14M9 16h14M9 21h9" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M21.5 8v16" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}

export function Wordmark({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="wordmark" aria-label="Intyr home">
      <Mark />
      <span>Intyr</span>
    </Link>
  );
}

function useCloseOnNavigate(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return [open, setOpen];
}

export function PublicLayout() {
  const [open, setOpen] = useCloseOnNavigate();
  return (
    <div className="site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container site-header-inner">
          <Wordmark />
          <nav className={cx("site-nav", open && "open")} aria-label="Main">
            <NavLink to="/#how-it-works">How it works</NavLink>
            <NavLink to="/docs/quickstart">Quickstart</NavLink>
            <NavLink to="/verify">Verify a receipt</NavLink>
            <NavLink to="/evidence">Evidence</NavLink>
          </nav>
          <div className="site-header-actions">
            <ButtonLink to="/app" variant="secondary" size="sm">
              Open sandbox
            </ButtonLink>
            <ButtonLink to="/app/demo" size="sm">
              Run a failing trip
            </ButtonLink>
            <button type="button" className="icon-btn menu-toggle" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? <X aria-hidden /> : <Menu aria-hidden />}
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="site-main">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer-inner">
        <p style={{ maxWidth: 520 }}>
          Intyr is a hackathon build for the Algorand Global x402 Challenge. Suppliers in this release are sandbox or simulated, and no bond or
          insurance covers any trip.
        </p>
        <nav aria-label="Footer">
          <Link to="/docs/quickstart">Quickstart</Link>
          <Link to="/verify">Verify</Link>
          <Link to="/evidence">Evidence</Link>
          <a href="/llms.txt">llms.txt</a>
          <a href="/openapi.json">OpenAPI</a>
          <a href="https://github.com/winsznx/intyr" rel="noreferrer">GitHub</a>
        </nav>
      </div>
    </footer>
  );
}

/** Shown on every sandbox screen so nothing here reads as a live booking. */
export function EnvStrip() {
  return (
    <div className="env-strip" role="note">
      <span className="env-dot" aria-hidden />
      <span>Sandbox on Algorand TestNet. Suppliers are in test mode or simulated. Nothing here books real travel or moves real money.</span>
    </div>
  );
}

function SessionNote() {
  const [session, setSession] = useState<SandboxSession | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    ensureSandboxSession()
      .then((s) => active && setSession(s))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);
  if (failed) return <span>Session not started. The API is not reachable.</span>;
  if (!session) return <span>Starting a sandbox session</span>;
  const expires = relativeTime(session.expires_at);
  return <span>Anonymous session{expires ? `, expires ${expires}` : ""}. No account or wallet needed.</span>;
}

export function AppLayout() {
  const [open, setOpen] = useCloseOnNavigate();
  return (
    <div className="app">
      <a className="skip-link" href="#app-main">
        Skip to content
      </a>
      <EnvStrip />
      <aside className={cx("app-rail", open && "open")} aria-label="Sandbox navigation">
        <Wordmark />
        <div className="rail-divider" />
        <nav className="rail-group" aria-label="Trips">
          <NavLink to="/app" end className="rail-link">
            <ListChecks aria-hidden /> Trips
          </NavLink>
          <NavLink to="/app/trips/new" className="rail-link">
            <Plus aria-hidden /> New trip
          </NavLink>
          <NavLink to="/app/demo" className="rail-link">
            <PlayCircle aria-hidden /> Run the demo
          </NavLink>
        </nav>
        <nav className="rail-group" aria-label="Proof">
          <span className="rail-group-label">Proof</span>
          <NavLink to="/verify" className="rail-link">
            <FileCheck2 aria-hidden /> Verify a receipt
          </NavLink>
          <NavLink to="/evidence" className="rail-link">
            <FlaskConical aria-hidden /> Evidence
          </NavLink>
          <NavLink to="/docs/quickstart" className="rail-link">
            <ScrollText aria-hidden /> API quickstart
          </NavLink>
        </nav>
        <div className="rail-foot">
          <SessionNote />
        </div>
      </aside>
      <div className={cx("rail-scrim", open && "open")} onClick={() => setOpen(false)} aria-hidden />
      <div className="app-main">
        <div className="app-mobile-bar">
          <Wordmark to="/app" />
          <button type="button" className="icon-btn" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}>
            <Menu aria-hidden />
          </button>
        </div>
        <div className="app-panel" id="app-main">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function AppBar({ crumbs, end }: { crumbs: Array<{ label: string; to?: string }>; end?: ReactNode }) {
  return (
    <div className="app-bar">
      <nav aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => (
          <span key={`${crumb.label}-${i}`} className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
            {i > 0 ? <span aria-hidden>/</span> : null}
            {crumb.to ? (
              <Link to={crumb.to}>{crumb.label}</Link>
            ) : (
              <span className="current" aria-current="page">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      {end ? <div className="app-bar-end">{end}</div> : null}
    </div>
  );
}
