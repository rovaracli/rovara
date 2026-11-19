import { Link } from "react-router";
import { PageHeader } from "../../../design/PageHeader.js";
import { KnownFailingPolicyRow } from "./KnownFailingPolicyRow.js";
import * as T from "./company-text.js";
import "./how-we-work.css";

/** Hosted company policy support is limited to known-failing policy. Model defaults live in the AI models for each step card. */
export function HowWeWorkCompanyScreen() {
 return <section><PageHeader focusOnMount title={T.PAGE_TITLE} description={T.PAGE_NOTE} />
  <p><Link to="/app/admin/ai-spending#ai-models">Back to AI models</Link></p>
  <KnownFailingPolicyRow />
 </section>;
}
