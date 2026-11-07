import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

const NEVER = { retry: "never" } as const;
const ANY = { parse: (value: unknown) => value };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROLE_WORDS: Record<string, string> = { owner: "Owner", commenter: "Commenter", viewer: "Viewer", denied: "Remove access" };

interface ReadComment { id: string; name: string; text: string; remembered: boolean | undefined }
interface ReadPerson { personId: string; name: string; role: string; you: boolean }
interface ReadPeople { revision: number; people: ReadPerson[]; canManage: boolean; canTakeOwnership: boolean }

/** The comments the review page took, as its own list reads them (`listPageComments`): people's, not deleted, with Remember state when the reader has standing. Anything malformed is left out. */
function readComments(value: unknown): { comments: ReadComment[]; canRemember: boolean } {
 const body = (value ?? {}) as { comments?: unknown; canRemember?: unknown };
 const comments = (Array.isArray(body.comments) ? body.comments : []).flatMap((raw): ReadComment[] => {
  const item = (raw ?? {}) as { id?: unknown; author?: { kind?: unknown; name?: unknown }; text?: unknown; deleted?: unknown; learning?: { remembered?: unknown } };
  if (typeof item.id !== "string" || !UUID.test(item.id) || item.author?.kind !== "person" || item.deleted === true || typeof item.text !== "string") return [];
  return [{ id: item.id, name: typeof item.author.name === "string" ? item.author.name : "Someone", text: item.text, remembered: typeof item.learning?.remembered === "boolean" ? item.learning.remembered : undefined }];
 });
 return { comments, canRemember: body.canRemember === true };
}

function readPeople(value: unknown): ReadPeople | undefined {
 const view = ((value ?? {}) as { view?: unknown }).view as { revision?: unknown; people?: unknown; canManage?: unknown; canTakeOwnership?: unknown } | undefined;
 if (view === undefined || typeof view.revision !== "number" || !Array.isArray(view.people)) return undefined;
 const people = view.people.flatMap((raw): ReadPerson[] => {
  const person = (raw ?? {}) as { personId?: unknown; name?: unknown; role?: unknown; you?: unknown };
  return typeof person.personId === "string" && UUID.test(person.personId) && typeof person.role === "string" ? [{ personId: person.personId, name: typeof person.name === "string" ? person.name : "Someone", role: person.role, you: person.you === true }] : [];
 });
 return { revision: view.revision, people, canManage: view.canManage === true, canTakeOwnership: view.canTakeOwnership === true };
}

/**
 * OWNER DECISION 7 item 9: what the old review page did for a task's people and its comments, on the task page. Remember and Forget on a comment go to the old page's own functions
 * (`rememberTaskComment`, `forgetTaskComment`, which check the person's standing in the project). A People role change and a take-over go through the task's People route that Slack and the MCP tool
 * use: each is a pending change the person confirms on its confirmation page. Nothing here decides who may; a refusal is shown in the server's words.
 */
export function TaskPagePeopleAndComments({ taskId }: { taskId: string }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const base = "/v1/app/tasks/" + encodeURIComponent(taskId);
 const comments = useQuery({ queryKey: ["task-comments", taskId], retry: false, queryFn: async () => readComments(await api.get(base + "/comments", ANY)) });
 const people = useQuery({ queryKey: ["task-people", taskId], retry: false, queryFn: async () => { try { return readPeople(await api.get(base + "/people", ANY)); } catch (failure) { if (failure instanceof ApiError && (failure.status === 404 || failure.status === 403)) return undefined; throw failure; } } });
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>(), [roles, setRoles] = useState<Record<string, string>>({});
 async function run(work: () => Promise<void>, said: string) {
  if (busy) return;
  setBusy(true);setError(undefined);setDone(undefined);
  try { await work();setDone(said); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't do that. Refresh the page and try again."); } finally { setBusy(false); }
 }
 /** A pending People change goes on to its confirmation page (a page of this origin); a committed one is read again. */
 async function propose(path: string, body: Record<string, unknown>) {
  const answer = await api.sendAnswer("POST", base + path, { ...body, requestId: crypto.randomUUID() }, ANY, NEVER) as { change?: { status?: unknown; confirmationUrl?: unknown } };
  const url = answer.change?.confirmationUrl;
  if (answer.change?.status === "PENDING" && typeof url === "string" && new URL(url, host.origin).origin === host.origin) { host.openExternal(new URL(url, host.origin).href);return; }
  await query.invalidateQueries({ queryKey: ["task-people", taskId] });
 }
 const learn = (comment: ReadComment, action: "remember" | "forget") => run(async () => {
  await api.sendAnswer("POST", base + "/comments/" + comment.id + "/" + action, {}, ANY, NEVER);
  await query.invalidateQueries({ queryKey: ["task-comments", taskId] });
 }, action === "remember" ? "Remembered for this project." : "Forgotten.");
 const list = comments.data?.comments ?? [], view = people.data;
 if (list.length === 0 && view === undefined) return null;
 return <section className="rv-task-people-comments" aria-label="People and comments">
  {view !== undefined && <div><h2>People</h2><ul>{view.people.map(person => <li key={person.personId}><VisibleText text={person.name + (person.you ? " (you)" : "") + ": " + (ROLE_WORDS[person.role] ?? "Role unknown")} />
   {view.canManage && <span><label htmlFor={"role-" + person.personId}>Access for {person.name}</label> <select id={"role-" + person.personId} value={roles[person.personId] ?? person.role} onChange={event => { const role = event.target.value;setRoles(current => ({ ...current, [person.personId]: role })); }}>{Object.entries(ROLE_WORDS).map(([role, words]) => <option key={role} value={role}>{words}</option>)}</select>
    <Button busy={busy} disabled={(roles[person.personId] ?? person.role) === person.role} onClick={() => { void run(() => propose("/people/role", { expectedPeopleRevision: view.revision, personId: person.personId, role: roles[person.personId] }), "Confirm the change on the next page."); }}>Review role change</Button></span>}
  </li>)}</ul>
   {view.canTakeOwnership && <p>Taking ownership does not restart work. <Button busy={busy} onClick={() => { void run(() => propose("/people/take-ownership", { expectedPeopleRevision: view.revision }), "Confirm on the next page."); }}>Take ownership</Button></p>}
  </div>}
  {list.length > 0 && <div><h2>Comments from the review page</h2><ul>{list.map(comment => <li key={comment.id}><p><VisibleText text={comment.name + ": " + comment.text} /></p>
   {comments.data?.canRemember === true && (comment.remembered === true
    ? <p><span>Remembered for this project</span> <Button variant="quiet" busy={busy} onClick={() => { void learn(comment, "forget"); }}>Forget</Button></p>
    : comment.remembered === false ? <Button variant="quiet" busy={busy} onClick={() => { void learn(comment, "remember"); }}>Remember this</Button> : null)}
  </li>)}</ul></div>}
  {done !== undefined && <p role="status">{done}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
