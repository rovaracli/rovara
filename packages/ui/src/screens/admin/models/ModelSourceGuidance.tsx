import type { z } from "zod";
import { VisibleText } from "../../../design/VisibleText.js";
import type { modelSourcesSnapshot } from "./source-order.js";
import "./model-source-guidance.css";
type Source = z.infer<typeof modelSourcesSnapshot>["sources"][number];
export function ModelSourceGuidance({ source, providerName }: { source: Source; providerName: string }) {
 return <details className="rv-model-source-guidance"><summary>Model source guidance for <VisibleText text={source.label} /></summary>
 <h3>Stored source evidence</h3><dl><dt>Provider</dt><dd>{providerName}</dd><dt>Credential evidence</dt><dd>{source.kind === "bedrock" ? "External setup only · Unverified" : source.hasCredential ? "Configured (stored flag)" : "Not configured (stored flag)"}</dd><dt>Catalog evidence</dt><dd>Configured entries: {source.models.length} · verified usable count unavailable</dd></dl>
 <p>Current model access: Unverified.</p><p>Configured model entries do not prove account-callable access.</p><p>Last credential change, last per-model verification, capabilities and pricing: Not returned.</p>
 <h3>Review setup with an authorized person</h3>
 {source.kind === "bedrock" ? <p>Ask the account's authorized administrator to arrange the guided external setup. This page cannot verify that account's model permissions or region access.</p> : source.kind === "endpoint" ? <p>Ask a company owner or admin to review the approved gateway endpoint and its intended model access. An endpoint entry does not prove model callability or permitted network access.</p> : <p>Ask a company owner or admin to review the intended provider account and approved source configuration.</p>}
 <p>A credential-presence flag does not prove validity; do not paste credentials into this page.</p>
 <p>Only fresh server-verified models callable by the current account may become selectable. This page does not verify models, enable providers or change running tasks.</p>
 <p>Opening this guidance makes no provider request and changes no configuration.</p></details>;
}
