import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DIAGNOSIS_ANSWER_LABEL, type DiagnosisStatusReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createDiagnosesApi } from "../../api/diagnoses.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";

type Proposal = NonNullable<ReturnType<typeof DiagnosisStatusReaderSchema.parse>["proposals"]>[number];

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** One proposal as plain text for a person. Nothing here can apply it: a diagnosis explains and suggests, and changes nothing. */
function ProposalText({ proposal }: { proposal: Proposal }) {
 switch (proposal.kind) {
  case "explain": return <VisibleText text={proposal.text} />;
  case "retry_with_note": return <>Retry with this note: <VisibleText text={proposal.note} /></>;
  case "redirect": return <>Tell the agent: <VisibleText text={proposal.text} /></>;
  case "new_task": return <>Start a new task: <VisibleText text={proposal.request} /></>;
  case "admin_steps": return <>For an admin: <ol>{proposal.steps.map((step, index) => <li key={index}><VisibleText text={step} /></li>)}</ol></>;
  case "settings_change": return <>Suggested setting change (<VisibleText text={proposal.target} />, <VisibleText text={proposal.path} />): <VisibleText text={show(proposal.from)} /> to <VisibleText text={show(proposal.to)} /></>;
  case "contact_support": return <>This needs help from outside the task.</>;
  default: return null;
 }
}

/**
 * "Fix with agent" for the error the session shows. Mounted only when the session view says it is on for this reader (`you.live.fix`) and carries an `errorRef`. Pressing the button asks for a diagnosis; the panel
 * then shows its explanation and proposals. It is read-only: there is no apply button. Every refusal (including "connect an AI provider") is the server's own sentence, shown as it came.
 */
export function FixWithAgentPanel({ errorRef }: { errorRef: NonNullable<ReadSession["errorRef"]> }) {
 const host = useAppHost(), api = useMemo(() => createDiagnosesApi(host), [host]);
 const [diagnosisId, setDiagnosisId] = useState<string>(), [sending, setSending] = useState(false), [error, setError] = useState<string>();
 const requestId = useRef<string>(undefined);
 const status = useQuery({
  queryKey: ["diagnosis", diagnosisId], enabled: diagnosisId !== undefined, retry: false, refetchOnWindowFocus: false,
  queryFn: () => api.status(diagnosisId!), refetchInterval: current => (current.state.data?.state === "ready" || current.state.data?.state === "failed" ? false : 2500),
 });
 async function start() {
  if (sending) return;
  requestId.current ??= crypto.randomUUID();
  setSending(true);setError(undefined);
  try { setDiagnosisId((await api.start({ requestId: requestId.current, errorRef })).diagnosisId); }
  catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't diagnose this now."); }
  finally { setSending(false); }
 }
 const state = status.data?.state, waiting = diagnosisId !== undefined && !status.isError && state !== "ready" && state !== "failed";
 const proposals = status.data?.proposals ?? [];
 return <section className="rv-fix-with-agent" aria-label="Fix with agent">
  <Button variant="secondary" busy={sending || waiting} onClick={() => { void start(); }}>Fix with agent</Button>
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {waiting && <p className="rv-muted" role="status">Looking into this error</p>}
  {diagnosisId !== undefined && status.isError && <p role="alert">{status.error instanceof ApiError ? <VisibleText text={status.error.message} /> : "Couldn't read the diagnosis. Try again."}</p>}
  {state === "failed" && <p role="alert"><VisibleText text={status.data?.failure ?? "Couldn't diagnose this now."} /></p>}
  {state === "ready" && <div role="status">
   {proposals.length === 0 ? <p>No suggestion came back for this error.</p> : <ul>{proposals.map((proposal, index) => <li key={index}><ProposalText proposal={proposal} /></li>)}</ul>}
   <p className="rv-muted"><VisibleText text={DIAGNOSIS_ANSWER_LABEL} /></p>
  </div>}
 </section>;
}
