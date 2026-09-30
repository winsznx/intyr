import { isRouteErrorResponse, useRouteError } from "react-router";
import { ButtonLink } from "../components/ui";

export function NotFound() {
  return (
    <section className="container section">
      <div className="stack" style={{ maxWidth: 560 }}>
        <h1 className="h2">This page does not exist</h1>
        <p className="body-l">
          The address may be mistyped, or it points to a part of Intyr that is not built in this release.
        </p>
        <div className="row">
          <ButtonLink to="/">Go to the home page</ButtonLink>
          <ButtonLink to="/verify" variant="secondary">
            Verify a receipt
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : "Unknown error";
  return (
    <section className="container section">
      <div className="stack" style={{ maxWidth: 560 }}>
        <h1 className="h2">This page failed to render</h1>
        <p className="body-l">Nothing was sent to a supplier by this error. Reload the page, or go back to your trips.</p>
        <code className="meta">{message}</code>
        <div className="row">
          <ButtonLink to="/app">Go to trips</ButtonLink>
          <ButtonLink to="/" variant="secondary">
            Home
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
