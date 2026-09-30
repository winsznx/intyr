import { createBrowserRouter } from "react-router";
import { AppLayout, PublicLayout } from "./components/shell";
import { RouteError, NotFound } from "./routes/not-found";
import { LandingPage } from "./routes/public/landing";
import { QuickstartPage } from "./routes/public/quickstart";
import { VerifyPage } from "./routes/public/verify";
import { EvidenceIndexPage, EvidenceRunPage } from "./routes/public/evidence";
import { ReplayPage } from "./routes/public/replay";
import { TripsPage } from "./routes/app/trips";
import { NewTripPage } from "./routes/app/new-trip";
import { TripPage } from "./routes/app/trip";
import { ApprovePage } from "./routes/app/approve";
import { DemoPage } from "./routes/app/demo";

export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <LandingPage /> },
      { path: "/docs/quickstart", element: <QuickstartPage /> },
      { path: "/verify", element: <VerifyPage /> },
      { path: "/verify/:manifestId", element: <VerifyPage /> },
      { path: "/evidence", element: <EvidenceIndexPage /> },
      { path: "/evidence/:runId", element: <EvidenceRunPage /> },
      { path: "/replay/:runId", element: <ReplayPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  {
    path: "/app",
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <TripsPage /> },
      { path: "trips/new", element: <NewTripPage /> },
      { path: "trips/:tripId", element: <TripPage /> },
      { path: "trips/:tripId/approve", element: <ApprovePage /> },
      { path: "demo", element: <DemoPage /> },
    ],
  },
]);
