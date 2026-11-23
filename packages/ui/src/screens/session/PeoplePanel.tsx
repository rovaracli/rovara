import { useTaskAction } from "../../api/task-action.js";
import { TaskActionNotice } from "./TaskActionNotice.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PEOPLE_NOT_AVAILABLE_TEXT, SESSION_PEOPLE_METHOD_LABELS, type SessionPeopleAddBody, type SessionPeopleOwnershipBody, type SessionPeopleRoleBody } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { servedReadState } from "../../api/served-read.js";
import { clockTime } from "./task-time.js";
import { createPeopleApi } from "../../api/people.js";
import { createSessionApi } from "../../api/sessions.js";
import { useAppHost } from "../../host.js";
import { safeExternalUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TaskMark } from "./task-marks.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { panelError, peopleFailure, type PeopleFailure } from "./people-failure.js";

/** Plain words for a failed request, and the fixed Ref code beside them (never the server's own text). */
function FailureRef({ failure }: { failure: PeopleFailure }) { return failure.ref === undefined ? null : <p className="rv-muted" data-testid="people-failure-ref"><code>Ref <VisibleText text={failure.ref} /></code></p>; }

const POLL_MS = 3000;
const ROLE_WORDS = { owner: "Owner", commenter: "Can comment", viewer: "Can view", denied: "Removed" } as const;
const ROLE_OPTIONS = [{ value: "owner", label: ROLE_WORDS.owner }, { value: "commenter", label: ROLE_WORDS.commenter }, { value: "viewer", label: ROLE_WORDS.viewer }] as const;
/** Code answers 404 or 501 for a People route it does not serve on this install: the panel says so in fixed words and nothing else breaks. */
const notServed = (error: unknown) => error instanceof ApiError && (error.status === 501 || (error.status === 404 && error.code !== "SESSION_NOT_FOUND" && error.code !== "TASK_NOT_FOUND"));
interface Waiting { confirmUrl: string; expiresAt: string; revision: number }

/**
 * Who is on this task: their roles and how they sign in, adding a person, changing a role, removing a person (the role "Removed") and taking ownership.
 * Rovara Code decides who may do each of these (the list says what this person may), and a change it asks the person to confirm waits here until Code shows it.
 * The list is read only while the panel is open.
 */
export function PeoplePanel({ id, shareRequest = 0 }: { id: string; /** D8: goes up each time Share asks the panel to open to add a viewer. */ shareRequest?: number }) {
 const page = useTaskPagePolicy(), host = useAppHost(), api = useMemo(() => createPeopleApi(host), [host]), shares = useMemo(() => createSessionApi(host), [host]), query = useQueryClient();
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string>(), [error, setError] = useState<PeopleFailure>();
 const [waiting, setWaitingState] = useState<Waiting>(), [candidateId, setCandidateId] = useState<string>(), [addRole, setAddRole] = useState<"owner" | "commenter" | "viewer">("commenter");
 // Share asked for the panel (D8): it opens, set to add a viewer, and the add form takes focus once its people are in.
 const [seenShare, setSeenShare] = useState(shareRequest), groupRef = useRef<HTMLDivElement>(null), focusedFor = useRef(shareRequest);
 if (shareRequest !== seenShare) { setSeenShare(shareRequest);setOpen(true);setAddRole("viewer"); }
 const inFlight = useRef(false), waitingRef = useRef<Waiting>(undefined), key = ["session", id, "people"];
 const setWaiting = useCallback((next: Waiting | undefined) => { waitingRef.current = next;setWaitingState(next); }, []);
 // A change waits until Code's list shows it (its revision moved), or its time ends: each read of the list checks.
 const list = useQuery({ queryKey: key, retry: false, enabled: open, refetchInterval: waiting === undefined ? false : POLL_MS, queryFn: async () => {
  const answer = await api.list(id);
  if (waitingRef.current !== undefined && answer.people.revision !== waitingRef.current.revision) {
   void checkPeople().then(resolved => { if (resolved) { setWaiting(undefined);setMessage("Done");void query.invalidateQueries({ queryKey: ["session", id], exact: true });void query.invalidateQueries({ queryKey: [...key, "candidates"] }); } }).catch(() => undefined);
  }
  return answer;
 } });
 const authorityUnread = !list.isSuccess || list.failureCount > 0;
 const action = useTaskAction(host, "people:" + id, open && !authorityUnread && (list.data?.people.canManage === true || list.data?.people.canTakeOwnership === true));
 const { data, staleSince } = servedReadState(list);
 const view = data?.people, canManage = view?.canManage === true;
 const candidates = useQuery({ queryKey: [...key, "candidates"], queryFn: () => api.candidates(id), enabled: open && canManage, retry: false, staleTime: 0 });
 useEffect(() => {
  if (waiting === undefined) return;
  const left = Date.parse(waiting.expiresAt) - Date.now();
  const timer = setTimeout(() => { setWaiting(undefined);setMessage("This change wasn't confirmed in time. Check before making another change."); }, Math.min(Math.max(left, 0), 2_000_000_000));
  return () => { clearTimeout(timer); };
 }, [waiting, setWaiting]);
 useEffect(() => {
  if (seenShare === focusedFor.current || candidates.data === undefined) return;
  focusedFor.current = seenShare;groupRef.current?.scrollIntoView({ block: "nearest" });groupRef.current?.querySelector("select")?.focus();
 }, [seenShare, candidates.data]);
 async function checkPeople(): Promise<boolean> {
  if (action.request?.action === "unshare") return action.check(() => shares.listShares(id), (answer, request) => !answer.shares.some(share => share.principal.kind === "member" && share.principal.developerId === request.body.developerId));
  return action.check(() => api.list(id), (answer, request) => {
   const body = request.body, people = answer.people.people;
   if (request.action === "ownership") return people.some(person => person.you && person.role === "owner");
   // Code's served person entries have personId, not the Cloud developerId
   // an add sends. A changed revision cannot identify that addition (R4).
   if (request.action === "add") return false;
   return people.some(person => person.personId === body.personId && person.role === body.role);
  });
 }
 function requirePeopleRead(): never { throw panelError(403, "FORBIDDEN", "These people or your permissions changed. Check the current list."); }
 async function readAuthority(revision: number, ownership = false): Promise<() => void> {
  // Refetch through the shared query: failures drop rendered authority, and a
  // cancelled older response cannot replace a newer refusal after remount.
  const current = await list.refetch(), basis = query.getQueryState(key);
  const check = () => {
   const latest = query.getQueryState(key);
   if (current.isError || current.isFetching || current.failureCount > 0 || current.data === undefined || basis === undefined || latest !== basis || latest.status !== "success" || latest.fetchFailureCount > 0 || latest.fetchStatus !== "idle" || latest.data !== current.data || current.data.people.revision !== revision || !(ownership ? current.data.people.canTakeOwnership : current.data.people.canManage)) requirePeopleRead();
  };
  check();return check;
 }
 async function run(kind: "role" | "add" | "ownership", body: SessionPeopleRoleBody | SessionPeopleAddBody | SessionPeopleOwnershipBody) {
  if (action.locked || authorityUnread || inFlight.current || view === undefined) return;
  inFlight.current = true;setBusy(true);setError(undefined);setMessage(undefined);
  try {
   let checkAuthority: () => void = requirePeopleRead;
   const answer = await action.run(kind, { ...body }, frozen => {
    checkAuthority();
    return kind === "role" ? api.role(id, frozen as unknown as SessionPeopleRoleBody) : kind === "add" ? api.add(id, frozen as unknown as SessionPeopleAddBody) : api.takeOwnership(id, frozen as unknown as SessionPeopleOwnershipBody);
   }, async () => { checkAuthority = await readAuthority(body.expectedPeopleRevision, kind === "ownership"); });
   if (answer.status === "COMMITTED") { query.setQueryData<NonNullable<typeof list.data>>(key, old => ({ ...old, people: answer.people }));setMessage("Done");void query.invalidateQueries({ queryKey: ["session", id], exact: true });void query.invalidateQueries({ queryKey: [...key, "candidates"] }); }
   else if (answer.status === "PENDING") setWaiting({ confirmUrl: answer.confirmUrl, expiresAt: answer.expiresAt, revision: view.revision });
  } catch (failure) {
   setError(peopleFailure(failure, "write"));
   // A stale list: read it again so the next try is against what Code shows now.
   if (failure instanceof ApiError && failure.status === 409) void list.refetch();
  } finally { inFlight.current = false;setBusy(false); }
 }
 // A person a Share made a reader (D8) is removed the way a share always was; the list then reads again.
 async function removeShared(developerId: string) {
  if (action.locked || authorityUnread || inFlight.current || view === undefined) return;
  inFlight.current = true;setBusy(true);setError(undefined);setMessage(undefined);
  try {
   let checkAuthority: () => void = requirePeopleRead;
   const result = await action.run("unshare", { requestId: crypto.randomUUID(), developerId }, () => {
    checkAuthority();return shares.unshare(id, "MEMBER#" + developerId);
   }, async () => { checkAuthority = await readAuthority(view.revision); });
   if (result.kind !== "done") throw panelError(409, "PENDING", "This change is waiting for confirmation. Reload this page to check it.");
   void query.invalidateQueries({ queryKey: key }).catch(() => undefined);
  } catch (failure) { setError(peopleFailure(failure, "remove")); }
  finally { inFlight.current = false;setBusy(false); }
 }
 const change = (personId: string, role: SessionPeopleRoleBody["role"]) => { if (view !== undefined) void run("role", { requestId: crypto.randomUUID(), expectedPeopleRevision: view.revision, personId, role }); };
 const safeConfirm = waiting === undefined ? undefined : safeExternalUrl(waiting.confirmUrl);
 const locked = action.locked || authorityUnread || busy || waiting !== undefined;
 // 4e disclosure (the same row as the page's other sections): who is on the task in one line, the list and the add form inside.
 const count = view === undefined ? undefined : view.people.filter(person => person.role !== "denied").length + (data?.sharedWith ?? []).length;
 return <details className="rv-people" data-testid="people-panel" open={open} onToggle={event => { setOpen(event.currentTarget.open); }}>
  {page === undefined ? <summary>People</summary> : <summary><TaskMark kind="chevron" /><strong>People</strong><span className="rv-task-section-summary">{count === undefined || count === 0 ? "Who is on this task" : String(count) + (count === 1 ? " person" : " people") + " on this task"}</span></summary>}
  <div className="rv-people-body">
  {list.isPending && open && <Skeleton label="Loading who is on this task" />}
  {staleSince !== undefined && <p className="rv-muted" role="status">Updated {clockTime(new Date(staleSince).toISOString())} · Reconnecting</p>}
  {list.isError && staleSince === undefined && (notServed(list.error)
   ? <p role="status" data-testid="people-unavailable">{PEOPLE_NOT_AVAILABLE_TEXT}</p>
   : <><div role="alert"><p><VisibleText text={peopleFailure(list.error, "read").text} /></p><Button onClick={() => { void list.refetch(); }}>Try again</Button></div><FailureRef failure={peopleFailure(list.error, "read")} /></>)}
  {view !== undefined && <>
   <ul className="rv-people-list" aria-label="People on this task">{view.people.map(person => {
    const label = person.method !== undefined && Object.hasOwn(SESSION_PEOPLE_METHOD_LABELS, person.method) ? SESSION_PEOPLE_METHOD_LABELS[person.method as keyof typeof SESSION_PEOPLE_METHOD_LABELS] : undefined;
    const roleWord = Object.hasOwn(ROLE_WORDS, person.role) ? ROLE_WORDS[person.role as keyof typeof ROLE_WORDS] : "Access unavailable";
    return <li key={person.personId} data-testid="people-row">
     <span className="rv-people-name"><span className="rv-people-who"><VisibleText text={person.name} /></span>{person.you && <span className="rv-muted"> (you)</span>}{label !== undefined && <span className="rv-muted"> · {label}</span>}</span>
     {canManage && person.role !== "denied"
      ? <Select label={"Role for " + person.name} value={Object.hasOwn(ROLE_WORDS, person.role) ? person.role : ""} disabled={locked} options={ROLE_OPTIONS} onValueChange={value => { if (value !== person.role && (value === "owner" || value === "commenter" || value === "viewer")) change(person.personId, value); }} />
      : <span className={page === undefined ? "rv-muted" : "rv-people-role"} data-testid="people-role">{roleWord}</span>}
     {canManage && person.role !== "denied" && <Button variant={page === undefined ? "quiet" : "secondary"} disabled={locked} aria-label={"Remove " + person.name} onClick={() => { change(person.personId, "denied"); }}>Remove</Button>}
    </li>;
   })}{(data?.sharedWith ?? []).map(shared => <li key={"shared-" + shared.developerId} data-testid="people-row">
     <span className="rv-people-name"><span className="rv-people-who"><VisibleText text={shared.name} /></span></span>
     <span className={page === undefined ? "rv-muted" : "rv-people-role"} data-testid="people-role">{Object.hasOwn(ROLE_WORDS, shared.role) ? ROLE_WORDS[shared.role as keyof typeof ROLE_WORDS] : "Access unavailable"}</span>
     {canManage && <Button variant={page === undefined ? "quiet" : "secondary"} disabled={locked} aria-label={"Remove " + shared.name} onClick={() => { void removeShared(shared.developerId); }}>Remove</Button>}
    </li>)}</ul>
   {view.canTakeOwnership && <div className="rv-people-ownership"><Button disabled={locked} onClick={() => { void run("ownership", { requestId: crypto.randomUUID(), expectedPeopleRevision: view.revision }); }}>Take ownership</Button></div>}
   {canManage && <div className="rv-people-add" role="group" aria-label="Add a person" ref={groupRef}>
    {page !== undefined && <h4 className="rv-people-add-title">Add someone</h4>}
    {candidates.isPending && <Skeleton label="Loading people you can add" />}
    {candidates.isError && (notServed(candidates.error)
     ? <p role="status" data-testid="people-add-unavailable">{PEOPLE_NOT_AVAILABLE_TEXT}</p>
     : <><p role="alert"><VisibleText text={peopleFailure(candidates.error, "candidates").text} /></p><FailureRef failure={peopleFailure(candidates.error, "candidates")} /></>)}
    {candidates.data !== undefined && (candidates.data.candidates.length === 0
     ? <p className="rv-muted">There is no one else to add right now.</p>
     : <>
      <Select label="Person" value={candidateId ?? ""} disabled={locked} placeholder="Choose a person" options={candidates.data.candidates.map(entry => ({ value: entry.developerId, label: entry.name }))} onValueChange={setCandidateId} />
      <Select label="Add as" value={addRole} disabled={locked} options={ROLE_OPTIONS} onValueChange={value => { if (value === "owner" || value === "commenter" || value === "viewer") setAddRole(value); }} />
      {!candidates.data.complete && <p className="rv-muted">Only some people are listed. Narrow the project's people if someone is missing.</p>}
      <Button variant={page === undefined ? "primary" : "secondary"} busy={busy} disabled={locked || candidateId === undefined} onClick={() => { if (candidateId !== undefined) void run("add", { requestId: crypto.randomUUID(), expectedPeopleRevision: view.revision, developerId: candidateId, role: addRole }); }}>Add person</Button>
     </>)}
   </div>}
  </>}
  {waiting !== undefined && <div role="status" data-testid="people-waiting"><p>Waiting for you to confirm this change in Rovara Code.</p>{safeConfirm !== undefined && <Button onClick={() => { host.openExternal(safeConfirm); }}>Open confirmation</Button>}<Button variant="quiet" onClick={() => { setWaiting(undefined);setMessage("Stopped waiting here. The change is still unconfirmed. Check before making another change."); }}>Cancel</Button></div>}
  {message && <p role="status" data-testid="people-message"><VisibleText text={message} /></p>}
  {error && <><p role="alert"><VisibleText text={error.text} /></p><FailureRef failure={error} /></>}
 <TaskActionNotice key={action.pendingKey} pending={action.pending} recovery={action.recovery} taskHref={"/app/sessions/" + encodeURIComponent(id)} check={checkPeople} />
  </div></details>;
}
