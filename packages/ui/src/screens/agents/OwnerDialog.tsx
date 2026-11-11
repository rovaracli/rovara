import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type AgentOwnerPutBodySchema } from "@agentx/cloud-contracts/web";
import { useAgentApi, type ReadAgent, type ReadAgentProfile } from "../../api/agents.js";
import type { SendResult } from "../../api/client.js";
import { Dialog } from "../../design/Dialog.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { agentAllows } from "./agent-access.js";
import { useAgentMembers, useAgentProjects, failureText } from "./agent-context.js";
export function OwnerDialog({ agent }: { agent: ReadAgent }) {
 const [open, setOpen] = useState(false), [kind, setKind] = useState("member"), [person, setPerson] = useState(""), [project, setProject] = useState(""), [accountable, setAccountable] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 const api = useAgentApi(), query = useQueryClient(), sending = useRef(false), members = useAgentMembers(open), projects = useAgentProjects(open && kind === "project");
 if (!agentAllows(agent, "manage")) return null;
 async function save() {
  if (sending.current || pending !== undefined || (kind === "member" ? !person : !project || !accountable)) return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   const owner: ReturnType<typeof AgentOwnerPutBodySchema.parse>["owner"] = kind === "project" ? { kind: "project", project } : { kind: "member", developerId: person };
   const result = await api.owner(agent.agentId, owner, kind === "project" ? { developerId: accountable } : undefined);
   if (result.kind !== "done") { setPending(result);return; }
   await query.invalidateQueries({ queryKey: ["agent", agent.agentId], exact: true });await query.invalidateQueries({ queryKey: ["agents"] });setOpen(false);
  } catch (failure) { setError(failureText(failure, "Couldn't change the owner. Try again.")); }
  finally { sending.current = false;setBusy(false); }
 }
 return <>{!agent.builtin && <Dialog title="Change owner" open={open} onOpenChange={value => { if (!busy) setOpen(value); }} trigger={<Button>Change owner</Button>}>
 <p>The current owner stays responsible until this change takes effect.</p><Select label="Owner type" value={kind} onValueChange={setKind} disabled={busy || pending !== undefined} options={[{ value: "member", label: "A person" }, { value: "project", label: "A project" }]} />
 {kind === "member" ? <Select label="New owner" value={person} onValueChange={setPerson} disabled={members.isPending || members.isError || busy || pending !== undefined} options={(members.isError ? [] : members.data?.members ?? []).map(member => ({ value: member.developerId, label: member.name }))} /> : <><Select label="New owner project" value={project} onValueChange={setProject} disabled={projects.isPending || projects.isError || busy || pending !== undefined} options={(projects.isError ? [] : projects.data?.projects ?? []).map(item => ({ value: item.name, label: item.name }))} /><Select label="Accountable maintainer" value={accountable} onValueChange={setAccountable} disabled={members.isPending || members.isError || busy || pending !== undefined} options={(members.isError ? [] : members.data?.members ?? []).map(member => ({ value: member.developerId, label: member.name }))} /></>}
 {(members.isError || projects.isError) && <p role="alert">Couldn't load the available owners. Close and reopen to try again.</p>}
 <Button variant="primary" busy={busy} disabled={pending !== undefined || members.isError || members.isPending || (kind === "member" ? !person : !project || !accountable || projects.isError || projects.isPending)} onClick={() => { void save(); }}>Save owner</Button>
 {error && <p role="alert"><VisibleText text={error} /></p>}{pending && <><p><VisibleText text={pending.kind === "needs_admin_approval" ? pending.message : "The current owner hasn't changed."} /></p><ConfirmInBrowser<ReadAgentProfile> result={pending} subjectKey={["agent", agent.agentId]} isApplied={view => kind === "member" ? view.agent.owner?.kind === "member" && view.agent.owner.developerId === person : view.agent.owner?.kind === "project" && view.agent.owner.project === project && view.agent.accountable?.developerId === accountable} onApplied={() => { setPending(undefined);setOpen(false); }} /></>}
 </Dialog>}{agent.owner?.kind === "project" && <AccountableDialog agent={agent} />}</>;
}
function AccountableDialog({ agent }: { agent: ReadAgent }) {
 const [open, setOpen] = useState(false), [person, setPerson] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), sending = useRef(false), members = useAgentMembers(open), api = useAgentApi(), query = useQueryClient();
 async function save() { if (sending.current || pending !== undefined || !person) return;sending.current = true;setBusy(true);setError(undefined);try { const result = await api.accountable(agent.agentId, person);if (result.kind !== "done") { setPending(result);return; }await query.invalidateQueries({ queryKey: ["agent", agent.agentId], exact: true });setOpen(false); } catch (failure) { setError(failureText(failure, "Couldn't change the accountable maintainer.")); } finally { sending.current = false;setBusy(false); } }
 return <Dialog title="Change accountable maintainer" open={open} onOpenChange={value => { if (!busy) setOpen(value); }} trigger={<Button>Change accountable maintainer</Button>}><Select label="Accountable maintainer" value={person} onValueChange={setPerson} disabled={members.isError || members.isPending || busy || pending !== undefined} options={(members.isError ? [] : members.data?.members ?? []).map(member => ({ value: member.developerId, label: member.name }))} /><Button busy={busy} disabled={!person || members.isError || members.isPending || pending !== undefined} onClick={() => { void save(); }}>Save accountable maintainer</Button>{error && <p role="alert"><VisibleText text={error} /></p>}{pending && <><p><VisibleText text={pending.kind === "needs_admin_approval" ? pending.message : "The accountable maintainer hasn't changed."} /></p><ConfirmInBrowser<ReadAgentProfile> result={pending} subjectKey={["agent", agent.agentId]} isApplied={view => view.agent.accountable?.developerId === person} onApplied={() => { setPending(undefined);setOpen(false); }} /></>}</Dialog>;
}
