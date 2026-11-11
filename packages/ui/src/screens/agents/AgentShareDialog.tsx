import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentPrincipalSchema, type AgentSharesResponseReaderSchema, AgentShareInputSchema, LEVEL_WORDS, principalKey } from "@agentx/cloud-contracts/web";
import { useAgentApi, type ReadAgent } from "../../api/agents.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Dialog } from "../../design/Dialog.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { agentAllows } from "./agent-access.js";
import { useAgentMembers, useAgentProjects, failureText } from "./agent-context.js";
type ReadShares = ReturnType<typeof AgentSharesResponseReaderSchema.parse>;
type Share = ReturnType<typeof AgentShareInputSchema.parse>;
export function AgentShareDialog({ agent }: { agent: ReadAgent }) {
 const [open, setOpen] = useState(false), [kind, setKind] = useState("member"), [target, setTarget] = useState(""), [level, setLevel] = useState("view"), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>(), [pending, setPending] = useState<{ result: Exclude<SendResult<unknown>, { kind: "done" }>; shares: Share[] }>();
 const api = useAgentApi(), query = useQueryClient(), sending = useRef(false), members = useAgentMembers(open), projects = useAgentProjects(open && kind === "project"), key = ["agent", agent.agentId, "shares"], read = useQuery({ queryKey: key, enabled: open && agentAllows(agent, "manage") && !agent.builtin, queryFn: () => api.shares(agent.agentId) });
 // RULING Q44: the owning shares routes require manage, including the read; built-ins cannot be shared.
 if (agent.builtin || !agentAllows(agent, "manage")) return null;
 const current: Share[] | undefined = read.isError ? undefined : read.data?.shares.flatMap(value => { const parsed = AgentShareInputSchema.safeParse({ principal: value.principal, level: value.level });return parsed.success ? [parsed.data] : []; });
 // An unknown share must never be erased by a read-modify-write client.
 const writable = current !== undefined && current.length === read.data?.shares.length;
 async function save(shares: Share[]) { if (sending.current || pending !== undefined || !writable) return;sending.current = true;setBusy(true);setError(undefined);setMessage(undefined);try { const result = await api.share(agent.agentId, shares);if (result.kind !== "done") { setPending({ result, shares });return; }await query.invalidateQueries({ queryKey: key });setMessage("Sharing updated"); } catch (failure) { setError(failureText(failure, "Couldn't change sharing. Try again.")); } finally { sending.current = false;setBusy(false); } }
 function add() { if (!current) return;const principal = AgentPrincipalSchema.parse(kind === "org" ? { kind: "org" } : kind === "project" ? { kind: "project", project: target } : { kind: "member", developerId: target });const share = AgentShareInputSchema.parse({ principal, level });void save([...current.filter(item => principalKey(item.principal) !== principalKey(principal)), share]); }
 const names = new Map(members.isError ? [] : members.data?.members.map(member => [member.developerId, member.name]));
 return <Dialog title="Share this workflow" className="rv-agent-dialog" open={open} onOpenChange={value => { if (!busy) setOpen(value); }} trigger={<Button>Share</Button>}><p>Let teammates use this method on their own work. Sessions keep their own sharing.</p>
 {read.isPending ? <p>Loading sharing</p> : read.isError ? <p role="alert">Couldn't load sharing. Close and reopen to try again.</p> : <ul>{read.data.shares.map((value, index) => { const parsed = AgentShareInputSchema.safeParse({ principal: value.principal, level: value.level });return <li key={parsed.success ? principalKey(parsed.data.principal) : index}>{parsed.success ? <><VisibleText text={parsed.data.principal.kind === "org" ? "Everyone in your company" : parsed.data.principal.kind === "project" ? parsed.data.principal.project : names.get(parsed.data.principal.developerId) ?? "Team member"} /> · {LEVEL_WORDS[parsed.data.level]} <Button disabled={busy || pending !== undefined || !writable} onClick={() => { void save(current!.filter(item => principalKey(item.principal) !== principalKey(parsed.data.principal))); }}>Remove</Button></> : "Access unavailable"}</li>; })}</ul>}
 <Select label="Share with" value={kind} disabled={busy || pending !== undefined} onValueChange={value => { setKind(value);setTarget(""); }} options={[{ value: "member", label: "A person" }, { value: "project", label: "A project" }, { value: "org", label: "Everyone in your company" }]} />
 {kind !== "org" && <Select label={kind === "project" ? "Project" : "Person"} value={target} onValueChange={setTarget} disabled={busy || pending !== undefined || (kind === "project" ? projects.isError || projects.isPending : members.isError || members.isPending)} options={kind === "project" ? (projects.isError ? [] : projects.data?.projects ?? []).map(item => ({ value: item.name, label: item.name })) : (members.isError ? [] : members.data?.members ?? []).map(item => ({ value: item.developerId, label: item.name }))} />}
 <Select label="Access level" value={level} onValueChange={setLevel} disabled={busy || pending !== undefined} options={["view", "use", "edit"].map(value => ({ value, label: LEVEL_WORDS[value as keyof typeof LEVEL_WORDS] }))} />
 {!writable && !read.isPending && !read.isError && <p role="alert">This sharing includes a newer access type. Refresh before changing it.</p>}
 <Button variant="primary" busy={busy} disabled={!writable || pending !== undefined || (kind !== "org" && !target) || (kind === "member" && members.isError) || (kind === "project" && projects.isError)} onClick={add}>Add share</Button>
 {error && <p role="alert"><VisibleText text={error} /></p>}{message && <p role="status">{message}</p>}{pending && <>{pending.result.kind === "needs_confirmation" && <ul>{pending.result.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul>}<ConfirmInBrowser<ReadShares> result={pending.result} subjectKey={key} isApplied={value => value.shares.length === pending.shares.length && value.shares.every(share => { const parsed = AgentShareInputSchema.safeParse({ principal: share.principal, level: share.level });return parsed.success && pending.shares.some(expected => principalKey(expected.principal) === principalKey(parsed.data.principal) && expected.level === parsed.data.level); })} onApplied={() => { setPending(undefined);setMessage("Sharing updated"); }} /></>}</Dialog>;
}
