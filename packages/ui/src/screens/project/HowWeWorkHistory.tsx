import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAgentVersions } from "../../api/agents.js";
import { useBuilderApi } from "../../api/builder.js";
import { howWeWorkKey, useHowWeWorkApi } from "../../api/how-we-work.js";
import type { SendResult } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText, useAgentMembers } from "../agents/agent-context.js";
import { RecipeDiffView, useRecipeDiff } from "../builder/RecipeDiffView.js";
import { PendingConfirmation, rolledBackMessage } from "./PendingConfirmation.js";
/** The versions of the project's process layer: who published each, when, the note, whether it was a less-safe change, and Rollback for a maintainer. */
export function HowWeWorkHistory({ project, agentId, canEdit, inUse = true, onChanged }: { project: string; agentId: string; canEdit: boolean; /** Whether the project runs this layer; when it runs the built-in, the current version is saved, not in use. */ inUse?: boolean; onChanged: () => void }) {
 const read = useAgentVersions(agentId), members = useAgentMembers(read.data !== undefined), names = new Map(members.data?.members.map(member => [member.developerId, member.name]) ?? []), [target, setTarget] = useState<number>();
 const opener = useRef<HTMLElement | null>(null);
 return <section className="rv-project-section" aria-labelledby="hww-history"><h2 id="hww-history" tabIndex={-1}>History</h2>
  {read.isPending ? <Skeleton label="Loading the history" /> : read.isError ? <p role="alert"><VisibleText text={failureText(read.error, "Couldn't read the history.")} /></p> : read.data.versions.length === 0 ? <p className="rv-muted">No versions yet. Publish your first change to start the history.</p> :
   <ol className="rv-hww-history">{[...read.data.versions].sort((a, b) => b.version - a.version).map(version => <li key={version.version}>
    <h3>Version {version.version}{version.current === true ? (inUse ? " · Running now" : " · Saved, not in use") : ""}</h3>
    <p className="rv-muted">{version.publishedBy !== undefined && <>By <VisibleText text={names.get(version.publishedBy) ?? "A team member"} /> </>}{version.publishedAt !== undefined && <RelativeTime at={version.publishedAt} />}</p>
    {version.note !== undefined && version.note !== "" && <p><VisibleText text={version.note} /></p>}
    {(version.safety === "less_safe" || (version.lessSafe?.length ?? 0) > 0) && <p><span className="rv-hww-marker" data-marker="less-safe">Less-safe change</span></p>}
    {canEdit && version.current !== true && <Button onClick={event => { opener.current = event.currentTarget;setTarget(version.version); }}>Roll back to version {version.version}</Button>}
   </li>)}</ol>}
  {target !== undefined && <RollbackDialog key={target} project={project} agentId={agentId} version={target} current={read.data?.versions.find(version => version.current === true)?.version} opener={opener} onClose={() => setTarget(undefined)} onChanged={onChanged} />}
 </section>;
}
function RollbackDialog({ project, agentId, version, current, opener, onClose, onChanged }: { project: string; agentId: string; version: number; current: number | undefined; opener: { current: HTMLElement | null }; onClose: () => void; onChanged: () => void }) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState(false), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), [checking, setChecking] = useState(false);
 const sending = useRef(false), requestId = useRef(crypto.randomUUID()), builder = useBuilderApi(), how = useHowWeWorkApi(), query = useQueryClient(), from = current ?? "base", diff = useRecipeDiff(agentId, from, version);
 async function run() {
  if (sending.current || pending !== undefined || done || diff.isPending || diff.isError) return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   const result = await builder.rollback(agentId, version, requestId.current);
   if (result.kind !== "done") { setPending(result);return; }
   setDone(true);onChanged();
  } catch (failure) { setError(failureText(failure, "Couldn't roll back. Try again.")); }
  finally { sending.current = false;setBusy(false); }
 }
 async function check() {
  setChecking(true);
  try { const fresh = await how.view(project);query.setQueryData([...howWeWorkKey(project), "view"], fresh);if ((fresh.process.kind === "project_process" ? fresh.process.version : fresh.process.draftLayer?.currentVersion) === version) { setPending(undefined);setDone(true);onChanged(); } }
  catch (failure) { setError(failureText(failure, "Couldn't check the status. Try again.")); }
  finally { setChecking(false); }
 }
 return <Dialog title={"Roll back to version " + String(version)} open onCloseAutoFocus={event => { event.preventDefault();(opener.current?.isConnected === true ? opener.current : document.getElementById("hww-history"))?.focus(); }} onOpenChange={value => { if (!value && !busy) onClose(); }}>
  <p>New tasks will use this saved version. Running tasks keep theirs.</p>
  <RecipeDiffView id={agentId} from={from} to={version} />
  <Button variant="primary" busy={busy} disabled={pending !== undefined || done || diff.isPending || diff.isError} onClick={() => { void run(); }}>Roll back</Button>
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  {done && <p role="status">{rolledBackMessage(version)}</p>}
  {pending !== undefined && <PendingConfirmation result={pending} checking={checking} onCheck={() => { void check(); }} />}
 </Dialog>;
}
