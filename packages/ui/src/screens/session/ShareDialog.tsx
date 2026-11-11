import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema, OrgMemberLookupBodySchema, OrgMemberLookupResponseReaderSchema, AppProjectsResponseSchema, LEVEL_WORDS, principalKey, AgentPrincipalSchema, type SessionSharesResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient, type SendResult } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { createSessionApi } from "../../api/sessions.js";
import { useAppHost } from "../../host.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { TextField } from "../../design/TextField.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
type Principal = ReturnType<typeof AgentPrincipalSchema.parse>;
type Shares = ReturnType<typeof SessionSharesResponseReaderSchema.parse>;
function knownPrincipalKey(value: Record<string, unknown>): string | undefined {
 const parsed = AgentPrincipalSchema.safeParse(value);
 return parsed.success ? principalKey(parsed.data) : undefined;
}
export function ShareDialog({ id, orgName, open: controlledOpen, onOpenChange, trigger, onCloseAutoFocus }: { id: string; orgName: string; open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: ReactElement; onCloseAutoFocus?: (event: Event) => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), sessions = useMemo(() => createSessionApi(host), [host]), query = useQueryClient();
 const [localOpen, setOpen] = useState(false), [search, setSearch] = useState(""), [kind, setKind] = useState("member"), [principal, setPrincipal] = useState<Principal>(), [level, setLevel] = useState<"view" | "use" | "edit">("view"), [busy, setBusy] = useState(false), [message, setMessage] = useState<string>(), [error, setError] = useState<string>();
 const open = controlledOpen ?? localOpen;
 const [lookup, setLookup] = useState<{ developerId: string; name: string } | null>(), [lookupBusy, setLookupBusy] = useState(false), [lookupError, setLookupError] = useState<string>();
 const lookupVersion = useRef(0);
 useEffect(() => () => { lookupVersion.current++; }, [open]);
 const [confirmed, setConfirmed] = useState(false);
 const [pending, setPending] = useState<{ result: Exclude<SendResult<unknown>, { kind: "done" }>; key: string; level: string }>();
 const inFlight = useRef(false), sharesKey = ["session", id, "shares"];
 const shares = useQuery({ queryKey: sharesKey, queryFn: () => sessions.listShares(id), enabled: open });
 const members = useQuery({ queryKey: ["session", id, "share-people"], queryFn: async () => { const answer = await api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema);return { members: answer.members.map(({ developerId, name, role }) => ({ developerId, name, role })) }; }, enabled: open, gcTime: 0, staleTime: 0 });
 const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get("/v1/app/projects", AppProjectsResponseSchema), enabled: open && kind === "project" });
 async function add() {
 if (principal === undefined || inFlight.current || pending !== undefined) return;inFlight.current = true;setBusy(true);setError(undefined);setMessage(undefined);
 try { const result = await sessions.share(id, principal, level);if (result.kind === "done") { setMessage("Shared");await query.invalidateQueries({ queryKey: sharesKey }); } else { setPending({ result, key: knownPrincipalKey(principal)!, level }); } } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't change sharing. Try again."); } finally { inFlight.current = false;setBusy(false); }
 }
 async function remove(value: Record<string, unknown>) {
 const key = knownPrincipalKey(value);if (key === undefined || inFlight.current || pending !== undefined) return;
 inFlight.current = true;setBusy(true);setError(undefined);setMessage(undefined);
 try { const result = await sessions.unshare(id, key);if (result.kind !== "done") { setPending({ result, key, level: "removed" });return; }await query.invalidateQueries({ queryKey: sharesKey }); }
 catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't remove sharing. Try again."); }
 finally { inFlight.current = false;setBusy(false); }
 }
 function changeOpen(value: boolean) {
 setOpen(value);onOpenChange?.(value);if (!value) { lookupVersion.current++;setLookup(undefined);setLookupBusy(false);setLookupError(undefined);setSearch("");setPrincipal(undefined);query.removeQueries({ queryKey: ["session", id, "share-people"] }); }if (!value && confirmed) { setPending(undefined);setConfirmed(false);setMessage(undefined);setPrincipal(undefined); }
 }
 const emailSearch = search.includes("@");
 const filtered = members.isError ? [] : emailSearch ? lookup ? [lookup] : [] : members.data?.members.filter(member => member.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
 async function findExactEmail() {
  const input = OrgMemberLookupBodySchema.safeParse({ email: search });if (!input.success) { setLookupError("Enter a complete email address.");return; }
  const version = ++lookupVersion.current;setLookupBusy(true);setLookupError(undefined);setLookup(undefined);setPrincipal(undefined);
  try {
   const result = await api.send("POST", "/v1/app/org/members/lookup", input.data, OrgMemberLookupResponseReaderSchema);
   if (lookupVersion.current !== version) return;
   if (result.kind !== "done") { setLookupError("Couldn't find a colleague. Try again.");return; }
   setLookup(result.value.match === null ? null : { developerId: result.value.match.developerId, name: result.value.match.name });
  } catch { if (lookupVersion.current === version) setLookupError("Couldn't find a colleague. Try again."); }
  finally { if (lookupVersion.current === version) setLookupBusy(false); }
 }
 function nameOf(value: Record<string, unknown>): string { if (value.kind === "org") return "Everyone in " + orgName;if (value.kind === "project" && typeof value.project === "string") return value.project;return members.data?.members.find(member => member.developerId === value.developerId)?.name ?? "Person"; }
 return <Dialog title="Share this session" open={open} onOpenChange={changeOpen} onCloseAutoFocus={onCloseAutoFocus} trigger={trigger ?? <Button>Share</Button>}><p className="rv-muted">Work together here. Sharing this session doesn't change the agent's instructions.</p>{shares.isPending ? <Skeleton label="Loading sharing" /> : shares.isError ? <p role="alert"><VisibleText text={shares.error instanceof ApiError ? shares.error.message : "Couldn't load sharing. Try again."} /></p> : <ul className="rv-share-list">{shares.data.shares.map((share, index) => <li key={knownPrincipalKey(share.principal) ?? index}><VisibleText text={nameOf(share.principal)} /> <span className="rv-muted">{share.level in LEVEL_WORDS ? LEVEL_WORDS[share.level as keyof typeof LEVEL_WORDS] : "Access unavailable"}</span>{knownPrincipalKey(share.principal) !== undefined && <Button variant="quiet" disabled={busy || pending !== undefined} aria-label={"Remove " + nameOf(share.principal)} onClick={() => { void remove(share.principal); }}>Remove</Button>}</li>)}</ul>}
 <Select label="Share with" disabled={busy || pending !== undefined} value={kind} onValueChange={value => { setKind(value);setPrincipal(value === "org" ? { kind: "org" } : undefined);setMessage(undefined); }} options={[{ value: "member", label: "A person" }, { value: "project", label: "A project" }, { value: "org", label: "Everyone in " + orgName }]} />
 {kind === "member" && <><TextField label="Find a person" disabled={busy || pending !== undefined} value={search} maxLength={254} onChange={event => { lookupVersion.current++;setSearch(event.target.value);setLookup(undefined);setLookupError(undefined);setLookupBusy(false);setPrincipal(undefined); }} />{emailSearch && <><Button disabled={busy || pending !== undefined || lookupBusy} onClick={() => { void findExactEmail(); }}>Find by exact email</Button>{lookupBusy && <p role="status">Finding a colleague</p>}{lookup === null && <p role="status">No matching colleague.</p>}{lookupError && <p role="alert">{lookupError}</p>}</>}<div className="rv-share-people">{filtered.map(member => <Button key={member.developerId} disabled={busy || pending !== undefined} aria-pressed={principal?.kind === "member" && principal.developerId === member.developerId} onClick={() => { setPrincipal({ kind: "member", developerId: member.developerId });setMessage(undefined); }}><VisibleText text={member.name} /></Button>)}</div>{members.isError && <p role="alert"><VisibleText text={members.error instanceof ApiError ? members.error.message : "Couldn't load people."} /></p>}</>}
 {kind === "project" && <>{projects.isPending && <Skeleton label="Loading projects" />}{projects.isError && <p role="alert"><VisibleText text={projects.error instanceof ApiError ? projects.error.message : "Couldn't load projects. Try again."} /></p>}<Select label="Project" disabled={projects.isPending || projects.isError || busy || pending !== undefined} onValueChange={project => setPrincipal({ kind: "project", project })} options={(projects.isError ? [] : projects.data?.projects ?? []).map(project => ({ value: project.name, label: project.name }))} /></>}
 <Select label="Access level" value={level} onValueChange={value => { if (value === "view" || value === "use" || value === "edit") setLevel(value); }} options={Object.entries(LEVEL_WORDS).map(([value, label]) => ({ value, label }))} disabled={busy || pending !== undefined} />
 <Button variant="primary" busy={busy} disabled={principal === undefined || pending !== undefined || shares.data === undefined || shares.isError || (kind === "member" && (members.isPending || members.isError)) || (kind === "project" && (projects.isPending || projects.isError))} onClick={() => { void add(); }}>Add share</Button>{message && <p><VisibleText text={message} /></p>}{error && <p role="alert"><VisibleText text={error} /></p>}{pending && <ConfirmInBrowser<Shares> onApplied={() => setConfirmed(true)} result={pending.result} subjectKey={sharesKey} isApplied={value => pending.level === "removed" ? !value.shares.some(share => knownPrincipalKey(share.principal) === pending.key) : value.shares.some(share => knownPrincipalKey(share.principal) === pending.key && share.level === pending.level)} />}</Dialog>;
}
