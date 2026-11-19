import { KF_POLICY as T } from "./company-text.js";
import "./how-we-work.css";

/** The fixed company explanation for known-failing marks. There is no configurable approval count. */
export function KnownFailingPolicyRow() {
 return <section aria-label={T.HEADING} className="rv-hww-company-card">
  <h2>{T.HEADING}</h2>
  <p>{T.EXPLANATION}</p>
 </section>;
}
