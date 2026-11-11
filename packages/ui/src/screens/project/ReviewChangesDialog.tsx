import { useRef, useState } from "react";
import { Link } from "react-router";
import { STAGE_IDS, type StageRefusal } from "@agentx/cloud-contracts/web";
import { useQueryClient } from "@tanstack/react-query";
import { useBuilderApi } from "../../api/builder.js";
import { howWeWorkKey, useHowWeWork, useHowWeWorkApi } from "../../api/how-we-work.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "../agents/agent-context.js";
import { RecipeDiffView, useRecipeDiff } from "../builder/RecipeDiffView.js";
import { summariseChange } from "./how-we-work-summary.js";
import { PendingConfirmation, publishedMessage } from "./PendingConfirmation.js";
import { isRefusalCode } from "../../api/stage-models.js";
import { ReasonRecord } from "./StageRecord.js";
import { STAGE_LABELS, codedText, refusalText } from "./stage-model-text.js";
import { safeAppPath } from "../../text/links.js";
/** "Review changes": what the draft changes against what runs now, the less-safe reasons, and Publish. A less-safe change waits for a second person; the page says so and never claims it is live. */
export function ReviewChangesDialog({ project, agentId, from, revision, disabled, notInUse = false, openRequest = 0, onPublished }: { project: string; agentId: string; from: number | "base"; revision: number; disabled: boolean; /** The project runs the built-in, not this layer: a publish saves a version only. */ notInUse?: boolean; /** Opens the dialog when it goes up (the page moved the draft and wants it reviewed), unless it is disabled: that request is dropped. */ openRequest?: number; onPublished: () => void }) {
 const [open, setOpen] = useState(false), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [refusals, setRefusals] = useState<StageRefusal[]>(), [published, setPublished] = useState<number>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), [checking, setChecking] = useState(false);
 const stages = useHowWeWork(project).data?.stages, sending = useRef(false), intent = useRef<{ body: string; id: string } | undefined>(undefined), builder = useBuilderApi(), how = useHowWeWorkApi(), query = useQueryClient(), diff = useRecipeDiff(agentId, from, "draft", open, revision);
 const [seenRequest, setSeenRequest] = useState(openRequest);
 if (openRequest !== seenRequest) { setSeenRequest(openRequest);if (openRequest > 0 && !disabled) { setNote("");setError(undefined);setRefusals(undefined);setPublished(undefined);setPending(undefined);setOpen(true); } }
 const summary = diff.data === undefined ? undefined : (() => { try { return summariseChange(diff.data); } catch { return undefined; } })(), empty = diff.data !== undefined && diff.data.changes.length === 0;
 async function publish() {
  if (sending.current || pending !== undefined || published !== undefined || diff.isPending || diff.isError || empty) return;
  sending.current = true;setBusy(true);setError(undefined);setRefusals(undefined);
  const body = JSON.stringify([revision, note]);if (intent.current?.body !== body) intent.current = { body, id: crypto.randomUUID() };
  try {
   const result = await builder.publish(agentId, revision, note, intent.current.id);
   if (result.kind !== "done") { setPending(result);return; }
   setPublished(result.value.version.version);onPublished();
  } catch (failure) {
   // A refusal for the model choices is lane C's (409 `{code, stage, fixHref}`): the fixed sentence is shown, never the code. Any other refusal is shown as the server wrote it.
   const found = failure instanceof ApiError && isRefusalCode(failure.code) && failure.refusal !== undefined && (STAGE_IDS as readonly string[]).includes(failure.refusal.stage) ? [{ code: failure.code, stage: failure.refusal.stage as StageRefusal["stage"], ...(failure.refusal.fixHref === undefined ? {} : { fixHref: failure.refusal.fixHref }) }] : undefined;
   setRefusals(found);setError((failure instanceof ApiError ? codedText(failure.code) : undefined) ?? failureText(failure, "Couldn't publish this draft. Your edits are saved as a draft."));if (failure instanceof ApiError && failure.code === "AGENT_REVISION_CONFLICT") onPublished(); }
  finally { sending.current = false;setBusy(false); }
 }
 /** A read, never a replay of the write: has the version that was waiting for confirmation been published? */
 async function check() {
  setChecking(true);
  try {
   const fresh = await how.view(project);query.setQueryData([...howWeWorkKey(project), "view"], fresh);
   const version = fresh.process.kind === "project_process" ? fresh.process.version : fresh.process.draftLayer?.currentVersion;
   if (version !== undefined && (from === "base" || version > from)) { setPending(undefined);setPublished(version);onPublished(); }
  } catch (failure) { setError(failureText(failure, "Couldn't check the status. Try again.")); }
  finally { setChecking(false); }
 }
 return <Dialog className="rv-publish-review" title="Review changes" open={open} onOpenChange={value => { if (busy) return;if (value) { setNote("");setError(undefined);setRefusals(undefined);setPublished(undefined);setPending(undefined); }setOpen(value); }} trigger={<Button variant="primary" disabled={disabled}>Review changes</Button>}>
  <p>{notInUse ? "This project runs Rovara Code's defaults. Publishing saves a new version but does not switch the project to it." : "Publishing changes how new tasks work. Running tasks keep their version."}</p>
  {diff.isPending ? <p role="status">Loading the changes</p> : diff.isError ? <p role="alert"><VisibleText text={failureText(diff.error, "Couldn't read these changes. Close this and try again.")} /></p> : <>
   {empty ? <p>There are no changes to publish.</p> : summary !== undefined && <section aria-label="What changes"><h3>What changes</h3><ul>{summary.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul></section>}
   {summary !== undefined && summary.lessSafe.length > 0 && <section aria-label="Needs someone else to confirm"><h3>Needs someone else to confirm</h3><p>These changes are less safe. Someone else who can approve changes in this project confirms them before they apply.</p><ul>{summary.lessSafe.map((reason, index) => <li key={index}><VisibleText text={reason} /><ReasonRecord reason={reason} stages={stages} /></li>)}</ul></section>}
   {!empty && diff.data?.comparison !== undefined && <RecipeDiffView id={agentId} from={from} to="draft" revision={revision} />}
  </>}
  <TextArea label="Version note" maxLength={200} value={note} disabled={busy || pending !== undefined || published !== undefined} onChange={event => setNote(event.target.value)} />
  <Button variant="primary" busy={busy} disabled={pending !== undefined || published !== undefined || diff.isPending || diff.isError || empty} onClick={() => { void publish(); }}>Publish</Button>
  {error !== undefined && (refusals === undefined ? <p role="alert"><VisibleText text={error} /></p> : <div role="alert"><p>These model choices can't be published yet.</p><ul>{refusals.map(refusal => <li key={refusal.stage}><VisibleText text={`${STAGE_LABELS[refusal.stage]}: ${refusalText(refusal.code)}`} />{refusal.fixHref !== undefined && safeAppPath(refusal.fixHref) && <> <Link to={refusal.fixHref}>How to fix this</Link></>}</li>)}</ul></div>)}
  {published !== undefined && <p role="status">{publishedMessage(published)}</p>}
  {pending !== undefined && <PendingConfirmation result={pending} checking={checking} onCheck={() => { void check(); }} stages={stages} />}
 </Dialog>;
}
