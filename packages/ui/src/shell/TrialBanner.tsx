import { Link } from "react-router";
import { paths } from "../paths.js";
export function TrialBanner({ state }: { state?: string | undefined }) {
 if (state === "locked") return <aside className="rv-trial-banner" aria-label="Free trial"><p>Connect GitHub to start your free trial.</p><Link to={paths.onboard} className="rv-button">Connect GitHub</Link></aside>;
 if (state === "github_used") return <aside className="rv-trial-banner" aria-label="Free trial"><p>This GitHub account already started a free trial for another organization. Connect a different GitHub account, or ask us about a plan.</p><Link to={paths.onboard} className="rv-button">Connect a different account</Link></aside>;
 return null;
}
