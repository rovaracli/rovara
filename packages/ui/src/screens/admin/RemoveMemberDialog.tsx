import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { MemberRemovalPreviewReaderSchema, MemberRemovalStartedReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
type Role = "owner" | "admin" | "member";
type Preview = ReturnType<typeof MemberRemovalPreviewReaderSchema.parse>;
const roleLabels: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const plural = (count: number, one: string, many = `${one}s`) => `${count >= 1000 ? "1000+" : String(count)} ${count === 1 ? one : many}`;
async function bounded<T>(work: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => { reject(new Error("Removal timed out.")); }, 30_000); })]); }
 finally { clearTimeout(timer); }
}
function movesOf(moves: Preview["moves"]): string[] {
 const lines = [
  moves.agents > 0 && plural(moves.agents, "agent"), moves.skills > 0 && plural(moves.skills, "skill"), moves.chains > 0 && plural(moves.chains, "chain"), moves.triggers > 0 && plural(moves.triggers, "trigger"),
  moves.approvals > 0 && `${plural(moves.approvals, "approval")} waiting on them`, moves.spendRequests > 0 && `${plural(moves.spendRequests, "spend request")} waiting on them`,
 ];
 return lines.filter((line): line is string => line !== false);
}
interface Props {
 company: string; member: { developerId: string; name: string; role: Role }; self: { developerId: string; name: string }; people: ReadonlyArray<{ developerId: string; name: string }>;
 checking: boolean; staleData: boolean; checkingReasonId: string; onRemoved: (message: string) => void; onDenied: () => void;
}
/** "Remove from company": a preview first, then one confirm that sends the removal with a request id. A retry after an unknown outcome reuses that id, so a repeat cannot remove or hand over twice. */
export function RemoveMemberDialog({ company, member, self, people, checking, staleData, checkingReasonId, onRemoved, onDenied }: Props) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [open, setOpen] = useState(false), [successor, setSuccessor] = useState(self.developerId), [busy, setBusy] = useState(false);
 const [shown, setMessage] = useState<string>(), [sent, setSent] = useState(false), [unknown, setUnknown] = useState(false), [stopped, setBlocked] = useState(false);
 const attempt = useRef<string | undefined>(undefined), sending = useRef(false), alive = useRef(true), reasonId = useId();
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 const previewQuery = useQuery({
  queryKey: ["admin", "removal-preview", member.developerId, successor], enabled: open, gcTime: 0, retry: false,
  queryFn: () => bounded(api.get(`/v1/app/org/members/${member.developerId}/removal-preview${successor === self.developerId ? "" : `?successorId=${successor}`}`, MemberRemovalPreviewReaderSchema)),
 });
 const preview = previewQuery.data, loading = open && previewQuery.isFetching, previewError = previewQuery.error;
 useEffect(() => { if (previewError instanceof ApiError && previewError.status === 403) onDenied(); }, [previewError, onDenied]);
 const previewMessage = previewError === null ? undefined : previewError instanceof ApiError && previewError.code === "SUCCESSOR_INVALID" ? "Pick someone who is still in the company to take over." : "The removal could not be previewed. Close and try again.";
 const message = previewMessage ?? shown, blocked = stopped || previewError !== null;
 function changeOpen(value: boolean) {
  if (sending.current || (value && (checking || staleData))) return;
  setOpen(value);
  if (value) { setSuccessor(self.developerId);setMessage(undefined);setSent(false);setUnknown(false);setBlocked(false);attempt.current = undefined; }
 }
 async function send() {
  if (sending.current || preview === undefined || blocked || checking || staleData) return;
  const requestId = attempt.current ??= globalThis.crypto.randomUUID();
  sending.current = true;setBusy(true);setSent(true);setUnknown(false);setMessage(undefined);
  try {
   const result = await bounded(api.send("POST", `/v1/app/org/members/${member.developerId}/removal`, { requestId, expectedRole: preview.member.role, successorId: successor }, MemberRemovalStartedReaderSchema, { retry: "never" }));
   if (result.kind !== "done") { setUnknown(true);setMessage("The removal is pending. Try the removal again to check it.");return; }
   onRemoved(result.value.message);
  } catch (error) {
   if (!alive.current) return;
   if (error instanceof ApiError && error.status === 403) { onDenied();setBlocked(true);setMessage("Your permission to remove people has ended. Close and reload.");return; }
   const code = error instanceof ApiError ? error.code : "";
   if (code === "CHANGE_STALE") { setBlocked(true);setMessage("Company members changed. Close and review the removal again."); }
   else if (code === "SUCCESSOR_INVALID") { setBlocked(true);setMessage("Pick someone who is still in the company to take over."); }
   else if (code === "LAST_OWNER") { setBlocked(true);setMessage("A company must keep at least one owner. Make someone else an owner first."); }
   else if (code === "NOT_FOUND") { setBlocked(true);setMessage("That person is no longer a member of this company. Close and reload."); }
   else { setUnknown(true);setMessage("The outcome is unknown. The removal may not have finished. Try the removal again: it will not hand anything over twice."); }
  } finally { sending.current = false;if (alive.current) setBusy(false); }
 }
 const moves = preview === undefined ? [] : movesOf(preview.moves);
 const successorName = preview?.successor.name ?? people.find(person => person.developerId === successor)?.name ?? self.name;
 const duties = preview === undefined ? [] : [
  preview.duties.wasRole !== "member" && `Was ${preview.duties.wasRole === "owner" ? "an Owner" : "an Admin"}. Company roles are never moved automatically.`,
  preview.duties.maintainerProjects > 0 && `Was a maintainer of ${plural(preview.duties.maintainerProjects, "project")}.`,
  preview.duties.invitesCreated > 0 && `${plural(preview.duties.invitesCreated, "open invite")} they created ${preview.duties.invitesCreated === 1 ? "is" : "are"} kept.`,
 ].filter((line): line is string => line !== false);
 return <Dialog title="Remove from company" description="Review who takes over and what ends before confirming." open={open} onOpenChange={changeOpen} trigger={<Button aria-disabled={checking || staleData} aria-describedby={checking || staleData ? checkingReasonId : undefined} aria-label={`Remove ${member.name} from company`}>Remove from company</Button>}>
  <div className="rv-admin-role-review" aria-busy={busy || loading}>
   {(checking || staleData) && <p id={reasonId} role={staleData ? "alert" : "status"}>{staleData ? "Member list is stale. Retry the member list before making a change." : "Checking company access..."}</p>}
   <p>Company: <VisibleText text={company} /></p><p><VisibleText text={member.name} /> ({roleLabels[member.role]})</p>
   <Select label="Who takes over?" value={successor} disabled={sent || busy} onValueChange={value => { setSuccessor(value); }} options={[{ value: self.developerId, label: `You (${self.name})` }, ...people.filter(person => person.developerId !== self.developerId && person.developerId !== member.developerId).map(person => ({ value: person.developerId, label: person.name }))]} />
   {loading && <p role="status">Checking what will move...</p>}
   {preview !== undefined && <>
    <section aria-labelledby={`${reasonId}-goes`}><p id={`${reasonId}-goes`}><strong>Goes to <VisibleText text={successorName} /></strong></p>{moves.length === 0 ? <p>Nothing is waiting to be handed over.</p> : <ul>{moves.map(line => <li key={line}>{line}</li>)}</ul>}</section>
    <section aria-labelledby={`${reasonId}-ends`}><p id={`${reasonId}-ends`}><strong>Ends now</strong></p><ul>{preview.ends.map(line => <li key={line}><VisibleText text={line} /></li>)}</ul></section>
    <section aria-labelledby={`${reasonId}-reassign`}><p id={`${reasonId}-reassign`}><strong>You'll need to reassign</strong></p>
     {duties.length === 0 ? <p>Nothing else was theirs to reassign.</p> : <ul>{duties.map(line => <li key={line}>{line}</li>)}</ul>}
     <p><Link to="/app/admin/people/roles">Roles</Link> · <Link to="/app/admin/projects">Projects</Link> · <Link to="/app/admin/invites">Invites</Link></p></section>
    {preview.warnings.map(line => <p key={line} className="rv-muted"><VisibleText text={line} /></p>)}
   </>}
   {message && <p role="alert">{message}</p>}
   <div className="rv-admin-role-actions">
    {unknown ? <Button variant="primary" busy={busy} onClick={() => { void send(); }}>Try the removal again</Button>
     : <Button variant="primary" busy={busy} disabled={preview === undefined || loading || blocked || checking || staleData || sent} onClick={() => { void send(); }}>{`Remove ${member.name}`}</Button>}
   </div>
   <p className="rv-muted">They can be invited again later. Running tasks are not handed over.</p>
  </div>
 </Dialog>;
}
