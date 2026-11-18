// The Vertex AI guide on the product AI form (L4-T4, setup review G4): three steps with copyable gcloud commands, filled with what Rovara knows,
// and the step a refusal sends the person back to. Copy gives exactly the text shown. Nothing here is a secret.
import { useState } from "react";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { vertexGuide, vertexRefusalHelp, type VertexRefusalReason, type VertexStepNumber } from "./vertex-guide.js";
import type { ProductAiRead } from "../../../api/admin-product-ai.js";

export function VertexGuide({ projectId, setup, usesServiceAccount, refusal }: { projectId: string; setup: ProductAiRead["vertexSetup"]; usesServiceAccount: boolean; refusal?: VertexRefusalReason | undefined }) {
 const host = useAppHost(), guide = vertexGuide({ projectId, setup });
 const [copied, setCopied] = useState<string>();
 const help = refusal === undefined ? undefined : vertexRefusalHelp(refusal, usesServiceAccount);
 const redo = (n: VertexStepNumber) => help !== undefined && (help.step === n || help.also === n);
 async function copy(id: string, text: string) {
  try { await (host.copyText !== undefined ? host.copyText(text) : navigator.clipboard.writeText(text)); setCopied(id); } catch { setCopied(`${id}:failed`); }
 }
 const Copy = ({ id, text, label }: { id: string; text: string; label: string }) => <><Button onClick={() => { void copy(id, text); }} aria-label={label}>Copy command</Button>{copied === id && <span role="status"> Copied.</span>}{copied === `${id}:failed` && <span role="alert"> Couldn't copy. Select the text and copy it.</span>}</>;
 return <div className="rv-vertex-guide" data-testid="vertex-guide">
  <h4>Connect Vertex AI in three steps</h4>
  <p>Someone who can edit IAM in your Google Cloud project runs these in Cloud Shell or any terminal signed in to gcloud (about 10 minutes). Rovara never gets a key: Google trusts a Rovara identity that carries your company's id.</p>
  {!guide.complete && <p role="note" data-testid="vertex-guide-incomplete">Rovara's AWS account and role name aren't available on this install yet, so those two values and your company id are shown as capital-letter placeholders. Ask the Rovara team for them before you run step 1.</p>}
  {help !== undefined && <p role="alert" data-testid="vertex-refusal-step">{help.text}</p>}
  <ol>
   {guide.steps.map(step => <li key={step.n} data-testid={`vertex-step-${String(step.n)}`} data-redo={redo(step.n) ? "true" : undefined}>
    <b>Step {step.n}: {step.title}</b>{redo(step.n) && <> <em>Redo this step</em></>}
    <p>{step.why}</p>
    <pre><code>{step.command}</code></pre>
    <p><Copy id={`step-${String(step.n)}`} text={step.command} label={`Copy step ${String(step.n)} command`} /></p>
    {step.n === 1 && <details open={refusal === "vertex_too_open" || undefined}><summary>The provider already exists without the condition</summary><pre><code>{guide.fixCondition}</code></pre><p><Copy id="fix" text={guide.fixCondition} label="Copy the condition fix command" /></p></details>}
   </li>)}
  </ol>
  <p>If this project's tests use workload identity themselves, set <code>GOOGLE_CLOUD_PROJECT</code> to the project id above.</p>
 </div>;
}
