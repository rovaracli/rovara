import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { createInsightsAccessApi, type InsightsAccess } from "../../api/insights.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { dateWords } from "./insights-format.js";

/**
 * The Insights viewer grant (owner or admin). A viewer is an extra grant on a member, not a fifth role: it lets the person see the company's Insights, with content only where they could already open it.
 * Standalone: it can be mounted on the People page or anywhere an owner or admin works (today it sits at the foot of the Insights screen). The server decides who may; a refusal is shown word for word.
 * A write is sent once from the browser session. REAUTH_REQUIRED offers "Sign in again".
 */
interface Problem { message: string; reauth: boolean }
const problem = (error: unknown): Problem => error instanceof ApiError ? { message: error.message, reauth: error.code === "REAUTH_REQUIRED" } : { message: "Rovara couldn't complete this. Try again shortly.", reauth: false };
export function InsightsViewerAccess({ orgScope }: { orgScope: string }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createInsightsAccessApi(host), [host]), members = useMemo(() => createApiClient(host), [host]);
 const accessKey = useMemo(() => ["insights", "access", orgScope], [orgScope]), memberKey = useMemo(() => ["insights", "access-members", orgScope], [orgScope]);
 const access = useQuery({ queryKey: accessKey, queryFn: () => api.list(), retry: false, gcTime: 0, refetchOnWindowFocus: false });
 const people = useQuery({ queryKey: memberKey, queryFn: () => members.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema), retry: false, gcTime: 0, refetchOnWindowFocus: false });
 const [choice, setChoice] = useState(""), [busy, setBusy] = useState<string>(), [error, setError] = useState<Problem>(), [note, setNote] = useState<string>(), [confirming, setConfirming] = useState<string>();
 const sending = useRef(false), alive = useRef(true), noteRef = useRef<HTMLParagraphElement>(null), headingId = useId();
 useEffect(() => { alive.current = true;return () => { alive.current = false; void query.cancelQueries({ queryKey: accessKey });query.removeQueries({ queryKey: accessKey });query.removeQueries({ queryKey: memberKey }); }; }, [query, accessKey, memberKey]);
 const holders = new Set((access.data?.viewers ?? []).map(entry => entry.person.id));
 // Only a plain member can be given the grant: an owner or admin already sees Insights, and an Auditor reads the audit log only. The server checks this too.
 const choices = (people.data?.members ?? []).filter(member => member.role === "member" && !holders.has(member.developerId));
 async function run(label: string, work: () => Promise<InsightsAccess>, done: string) {
  if (sending.current) return;
  sending.current = true;setBusy(label);setError(undefined);setNote(undefined);
  try {
   const answer = await work();
   if (!alive.current) return;
   query.setQueryData(accessKey, answer);setNote(done);setConfirming(undefined);setChoice("");
   setTimeout(() => { noteRef.current?.focus(); }, 0);
  } catch (caught) { if (alive.current) setError(problem(caught)); }
  finally { sending.current = false;if (alive.current) setBusy(undefined); }
 }
 const nameOf = (id: string) => people.data?.members.find(member => member.developerId === id)?.name ?? "That person";
 const grant = () => { if (choice !== "") { const name = nameOf(choice);void run("grant", () => api.grant(choice), `${name} can now see Insights.`); } };
 const revoke = (id: string, name: string) => run("revoke:" + id, () => api.revoke(id), `${name} can no longer see Insights.`);
 return <section className="rv-ins-panel rv-surface rv-ins-access" aria-labelledby={headingId}>
  <h2 id={headingId}>Who can see Insights</h2>
  <p className="rv-muted">Owners and admins always can. An Insights viewer sees the whole company&apos;s Insights, but only sees what is in a task where they could already open it. A viewer cannot see spending by person.</p>
  {note !== undefined && <p ref={noteRef} tabIndex={-1} role="status"><VisibleText text={note} /></p>}
  {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}</p>}
  {access.isPending ? <Skeleton label="Loading Insights viewers" /> : access.isError ? <p role="alert">Couldn&apos;t load who can see Insights. <Button onClick={() => { void access.refetch(); }}>Try again</Button></p> : <>
   {access.data.viewers.length === 0 ? <p>No one has been given Insights access yet.</p> : <ul className="rv-ins-viewers" aria-label="Insights viewers">{access.data.viewers.map(entry => <li key={entry.person.id}>
    <span><strong><VisibleText text={entry.person.name} /></strong><span className="rv-muted"> given access by <VisibleText text={entry.grantedBy.name} /> on {dateWords(entry.grantedAt)}</span></span>
    {confirming === entry.person.id ? <span className="rv-ins-confirm"><Button variant="primary" aria-label={`Yes, remove access for ${entry.person.name}`} busy={busy === "revoke:" + entry.person.id} disabled={busy !== undefined} onClick={() => { void revoke(entry.person.id, entry.person.name); }}>Yes, remove access</Button><Button disabled={busy !== undefined} onClick={() => { setConfirming(undefined); }}>Keep access</Button></span>
     : <Button aria-label={`Remove access for ${entry.person.name}`} disabled={busy !== undefined} onClick={() => { setConfirming(entry.person.id); }}>Remove access</Button>}
   </li>)}</ul>}
   <p className="rv-muted">{String(access.data.eligibleCount)} {access.data.eligibleCount === 1 ? "person" : "people"} could be given access.</p>
   {people.isPending ? <Skeleton label="Loading company members" /> : people.isError ? <p role="alert">Couldn&apos;t load the company&apos;s members, so no one can be added just now. <Button onClick={() => { void people.refetch(); }}>Try again</Button></p> : choices.length === 0 ? <p>No other member can be given access.</p> : <form className="rv-ins-grant" onSubmit={event => { event.preventDefault();grant(); }}>
    <Select label="Give Insights access to" value={choice} onValueChange={setChoice} placeholder="Choose a person" options={choices.map(member => ({ value: member.developerId, label: member.name }))} disabled={busy !== undefined} />
    <Button type="submit" variant="primary" busy={busy === "grant"} disabled={choice === "" || busy !== undefined}>Give access</Button>
   </form>}
  </>}
 </section>;
}
