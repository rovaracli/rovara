import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { paths } from "../paths.js";
import { isBillingV2On } from "../billing-flags.js";
import { useAppHost } from "../host.js";
import { PartBoundary } from "./ErrorBoundary.js";
/** The trial allowance banner (lane exp/trial-billing). Its own chunk, fetched only while the device's billing switch is on; with the switch off this file renders exactly what it did before. */
const BillingBanner = lazy(() => import("../screens/billing/BillingBanner.js"));
export function TrialBanner({ state }: { state?: string | undefined }) {
 const host = useAppHost();
 if (state === "locked") return <aside className="rv-trial-banner" aria-label="Free trial"><p>Connect GitHub to start your free trial.</p><Link to={paths.onboard} className="rv-button">Connect GitHub</Link></aside>;
 if (state === "github_used") return <aside className="rv-trial-banner" aria-label="Free trial"><p>This GitHub account already started a free trial for another organization. Connect a different GitHub account, or ask us about a plan.</p><Link to={paths.onboard} className="rv-button">Connect a different account</Link></aside>;
 if (isBillingV2On(host)) return <PartBoundary fallback={null}><Suspense fallback={null}><BillingBanner /></Suspense></PartBoundary>;
 return null;
}
