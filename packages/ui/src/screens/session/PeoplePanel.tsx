import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PEOPLE_NOT_AVAILABLE_TEXT, SESSION_PEOPLE_METHOD_LABELS, type SessionPeopleRoleBody } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { createPeopleApi } from "../../api/people.js";
import { createSessionApi } from "../../api/sessions.js";
import { useAppHost } from "../../host.js";
import { safeExternalUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";

const POLL_MS = 3000;
const ROLE_WORDS = { owner: "Owner", commenter: "Can comment", viewer: "Can view", denied: "Removed" } as const;
const ROLE_OPTIONS = [{ value: "owner", label: ROLE_WORDS.owner }, { value: "commenter", label: ROLE_WORDS.commenter }, { value: "viewer", label: ROLE_WORDS.viewer }] as const;
/** Code answers 404 or 501 for a People route it does not serve on this install: the panel says so in fixed words and nothing else breaks. */
const notServed = (error: unknown) => error instanceof ApiError && (error.status === 501 || (error.status === 404 && error.code !== "SESSION_NOT_FOUND" && error.code !== "TASK_NOT_FOUND"));
const failureText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);
interface Waiting { confirmUrl: string; expiresAt: string; revision: number }

/**
 * Who is on this task: their roles and how they sign in, adding a person, changing a role, removing a person (the role "Removed") and taking ownership.
 * Rovara Code decides who may do each of these (the list says what this person may), and a change it asks the person to confirm waits here until Code shows it.
 * The list is read only while the panel is open.
 */
export function PeoplePanel({ id, shareRequest = 0 }: { id: string; /** D8: goes up each time Share asks the panel to open to add a viewer. */ shareRequest?: number }) {
 const host = useAppHost(), api = useMemo(() => createPeopleApi(host), [host]), shares = useMemo(() => createSessionApi(host), [host]), query = useQueryClient();
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string>(), [error, setError] = useState<string>();
 const [waiting, setWaitingState] = useState<Waiting>(), [candidateId, setCandidateId] = useState<string>(), [addRole, setAddRole] = useState<"owner" | "commenter" | "viewer">("commenter");
 // Share asked for the panel (D8): it opens, set to add a viewer, and the add form takes focus once its people are in.
 const [seenShare, setSeenShare] = useState(shareRequest), groupRef = useRef<HTMLDivElement>(null), focusedFor = useRef(shareRequest);
 if (shareRequest !== seenShare) { setSeenShare(shareRequest);setOpen(true);setAddRole("viewer"); }
 const inFlight = useRef(false), waitingRef = useRef<Waiting>(undefined), key = ["session", id, "people"];
 const setWaiting = useCallback((next: Waiting | undefined) => { waitingRef.current = next;setWaitingState(next); }, []);
 // A change waits until Code's list shows it (its revision moved), or its time ends: each read of the list checks.
 const list = useQuery({ queryKey: key, retry: false, enabled: open, refetchInterval: waiting === undefined ? false : POLL_MS, queryFn: async () => {
  const answer = await api.list(id);
  if (waitingRef.current !== undefined && answer.people.revision !== waitingRef.current.revision) { setWaiting(undefined);setMessage("Done");void query.invalidateQueries({ queryKey: ["session", id], exact: true });void query.invalidateQueries({ queryKey: [...key, "candidates"] }); }
  return answer;
 } });
 const view = list.data?.people, canManage = view?.canManage === true;
 const candidates = useQuery({ queryKey: [...key, "candidates"], queryFn: () => api.candidates(id), enabled: open && canManage, retry: false, staleTime: 0 });
 useEffect(() => {
  if (waiting === undefined) return;
  const left = Date.parse(waiting.expiresAt) - Date.now();
  const timer = setTimeout(() => { setWaiting(undefined);setMessage("This change wasn't confirmed in time. Try again."); }, Math.min(Math.max(left, 0), 2_000_000_000));
  return () => { clearTimeout(timer); };
 }, [waiting, setWaiting]);
 useEffect(() => {
  if (seenShare === focusedFor.current || candidates.data === undefined) return;
  focusedFor.current = seenShare;groupRef.current?.scrollIntoView({ block: "nearest" });groupRef.current?.querySelector("select")?.focus();
 }, [seenShare, candidates.data]);
 async function run(ask: () => ReturnType<typeof api.role>) {
  if (inFlight.current || view === undefined) return;
  inFlight.current = true;setBusy(true);setError(undefined);setMessage(undefined);
  try {
   const answer = await ask();
   if (answer.status === "COMMITTED") { query.setQueryData(key, { people: answer.people });setMessage("Done");void query.invalidateQueries({ queryKey: ["session", id], exact: true });void query.invalidateQueries({ queryKey: [...key, "candidates"] }); }
   else if (answer.status === "PENDING") setWaiting({ confirmUrl: answer.confirmUrl, expiresAt: answer.expiresAt, revision: view.revision });
  } catch (failure) {
   setError(failureText(failure, "Couldn't change who is on this task. Try again."));
   // A stale list: read it again so the next try is against what Code shows now.
   if (failure instanceof ApiError && failure.status === 409) void list.refetch();
  } finally { inFlight.current = false;setBusy(false); }
 }
 // A person a Share made a reader (D8) is removed the way a share always was; the list then reads again.
 async function removeShared(developerId: string) {
  if (inFlight.current) return;
  inFlight.current = true;setBusy(true);setError(undefined);setMessage(undefined);
  try {
   const result = await shares.unshare(id, "MEMBER#" + developerId);
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation. Reload this page to check it.");
   await query.invalidateQueries({ queryKey: key });
  } catch (failure) { setError(failureText(failure, "Couldn't remove this person. Try again.")); }
  finally { inFlight.current = false;setBusy(false); }
 }
 const change = (personId: string, role: SessionPeopleRoleBody["role"]) => { if (view !== undefined) void run(() => api.role(id, { requestId: crypto.randomUUID(), expectedPeopleRevision: view.revision, personId, role })); };
 const safeConfirm = waiting === undefined ? undefined : safeExternalUrl(waiting.confirmUrl);
 const locked = busy || waiting !== undefined;
 return <details className="rv-people" data-testid="people-panel" open={open} onToggle={event => { setOpen(event.currentTarget.open); }}>
  <summary>People</summary>
  {list.isPending && open && <Skeleton label="Loading who is on this task" />}
  {list.isError && (notServed(list.error)
   ? <p role="status" data-testid="people-unavailable">{PEOPLE_NOT_AVAILABLE_TEXT}</p>
   : <div role="alert"><p><VisibleText text={failureText(list.error, "Couldn't load who is on this task.")} /></p><Button onClick={() => { void list.refetch(); }}>Try again</Button></div>)}
  {view !== undefined && <>
   <ul className="rv-people-list" aria-label="People on this task">{view.people.map(person => {
    const label = person.method !== undefined && Object.hasOwn(SESSION_PEOPLE_METHOD_LABELS, person.method) ? SESSION_PEOPLE_METHOD_LABELS[person.method as keyof typeof SESSION_PEOPLE_METHOD_LABELS] : undefined;
    const roleWord = Object.hasOwn(ROLE_WORDS, person.role) ? ROLE_WORDS[person.role as keyof typeof ROLE_WORDS] : "Access unavailable";
    return <li key={person.personId} data-testid="people-row">
     <span className="rv-people-name"><VisibleText text={person.name} />{person.you && <span className="rv-muted"> (you)</span>}{label !== undefined && <span className="rv-muted"> · {label}</span>}</span>
     {canManage && person.role !== "denied"
      ? <Select label={"Role for " + person.name} value={Object.hasOwn(ROLE_WORDS, person.role) ? person.role : ""} disabled={locked} options={ROLE_OPTIONS} onValueChange={value => { if (value !== person.role && (value === "owner" || value === "commenter" || value === "viewer")) change(person.personId, value); }} />
      : <span className="rv-muted" data-testid="people-role">{roleWord}</span>}
     {canManage && person.role !== "denied" && <Button variant="quiet" disabled={locked} aria-label={"Remove " + person.name} onClick={() => { change(person.personId, "denied"); }}>Remove</Button>}
    </li>;
   })}{(list.data?.sharedWith ?? []).map(shared => <li key={"shared-" + shared.developerId} data-testid="people-row">
     <span className="rv-people-name"><VisibleText text={shared.name} /></span>
     <span className="rv-muted" data-testid="people-role">{Object.hasOwn(ROLE_WORDS, shared.role) ? ROLE_WORDS[shared.role as keyof typeof ROLE_WORDS] : "Access unavailable"}</span>
     {canManage && <Button variant="quiet" disabled={locked} aria-label={"Remove " + shared.name} onClick={() => { void removeShared(shared.developerId); }}>Remove</Button>}
    </li>)}</ul>
   {view.canTakeOwnership && <Button disabled={locked} onClick={() => { void run(() => api.takeOwnership(id, { requestId: crypto.randomUUID(), expectedPeopleRevision: view.revision })); }}>Take ownership</Button>}
   {canManage && <div className="rv-people-add" role="group" aria-label="Add a person" ref={groupRef}>
    {candidates.isPending && <Skeleton label="Loading people you can add" />}
    {candidates.isError && (notServed(candidates.error)
     ? <p role="status" data-testid="people-add-unavailable">{PEOPLE_NOT_AVAILABLE_TEXT}</p>
     : <p role="alert"><VisibleText text={failureText(candidates.error, "Couldn't load the people you can add.")} /></p>)}
    {candidates.data !== undefined && (candidates.data.candidates.length === 0
     ? <p className="rv-muted">There is no one else to add right now.</p>
     : <>
      <Select label="Person" value={candidateId ?? ""} disabled={locked} placeholder="Choose a person" options={candidates.data.candidates.map(entry => ({ value: entry.developerId, label: entry.name }))} onValueChange={setCandidateId} />
      <Select label="Add as" value={addRole} disabled={locked} options={ROLE_OPTIONS} onValueChange={value => { if (value === "owner" || value === "commenter" || value === "viewer") setAddRole(value); }} />
      {!candidates.data.complete && <p className="rv-muted">Only some people are listed. Narrow the project's people if someone is missing.</p>}
      <Button variant="primary" busy={busy} disabled={candidateId === undefined || waiting !== undefined} onClick={() => { if (candidateId !== undefined) void run(() => api.add(id, { requestId: crypto.randomUUID(), expectedPeopleRevision: view.revision, developerId: candidateId, role: addRole })); }}>Add person</Button>
     </>)}
   </div>}
  </>}
  {waiting !== undefined && <div role="status" data-testid="people-waiting"><p>Waiting for you to confirm this change in Rovara Code.</p>{safeConfirm !== undefined && <Button onClick={() => { host.openExternal(safeConfirm); }}>Open confirmation</Button>}<Button variant="quiet" onClick={() => { setWaiting(undefined); }}>Cancel</Button></div>}
  {message && <p role="status" data-testid="people-message"><VisibleText text={message} /></p>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </details>;
}
