import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createCompanyDomainsApi, type CompanyDomain } from "../../../api/company-domains.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";

const STATE_WORDS: Readonly<Record<string, string>> = { pending: "Not verified yet", verified: "Verified", lost: "Lost" };
const RESULT_WORDS: Readonly<Record<string, string>> = {
 found: "The record was found.",
 not_found: "The record was not found. DNS changes can take a while to spread; check again later.",
 indirect: "The name is an alias (a CNAME). Put the record directly on this name, not behind an alias.",
 held: "Your record was found, but another company currently holds this domain. It moves to you only after their record has been gone for 3 days and yours has stayed the only one in DNS for at least an hour between two checks.",
 unavailable: "The record could not be looked up just now. This does not count against a verified domain. Check again later.",
};
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }) + " UTC";
const problem = (error: unknown): { message: string; reauth: boolean } => error instanceof ApiError ? { message: error.message, reauth: error.code === "REAUTH_REQUIRED" } : { message: "Rovara couldn't complete this. Try again shortly.", reauth: false };

export function CompanyDomainsScreen() {
 const { orgId, developerId, role } = useAdminContext();
 if (role !== "owner") return <section><PageHeader focusOnMount title="Company domains" /><p role="alert">Only a company owner can see or change company domains.</p></section>;
 return <Domains key={`${orgId}:${developerId}`} orgId={orgId} developerId={developerId} />;
}

function Domains({ orgId, developerId }: { orgId: string; developerId: string }) {
 const host = useAppHost(), api = useMemo(() => createCompanyDomainsApi(host), [host]), query = useQueryClient();
 const key = useMemo(() => ["admin", "company-domains", orgId, developerId], [orgId, developerId]);
 const read = useQuery({ queryKey: key, queryFn: () => api.list(), gcTime: 0, refetchOnWindowFocus: false });
 const [typed, setTyped] = useState(""), [busy, setBusy] = useState<string>(), [error, setError] = useState<{ message: string; reauth: boolean }>(), [note, setNote] = useState<{ domain: string; text: string }>();
 const [removing, setRemoving] = useState<CompanyDomain>(), sending = useRef(false);
 useEffect(() => () => { void query.cancelQueries({ queryKey: key }); query.removeQueries({ queryKey: key }); }, [query, key]);

 async function run(label: string, work: () => Promise<void>) {
  if (sending.current) return;
  sending.current = true;setBusy(label);setError(undefined);setNote(undefined);
  try { await work(); await read.refetch(); }
  catch (caught) { setError(problem(caught));if (caught instanceof ApiError && [401, 403].includes(caught.status) && caught.code !== "REAUTH_REQUIRED") void query.invalidateQueries({ queryKey: ["admin", "identity"] }); }
  finally { sending.current = false;setBusy(undefined); }
 }
 const add = () => run("add", async () => { await api.add(typed);setTyped(""); });
 const check = (domain: string) => run("check:" + domain, async () => { const answer = await api.check(domain);setNote({ domain, text: answer.result === undefined ? "" : RESULT_WORDS[answer.result] ?? "" }); });
 const remove = (domain: string) => run("remove:" + domain, async () => { await api.remove(domain);setRemoving(undefined); });

 return <section aria-busy={read.isFetching}>
  <PageHeader focusOnMount title="Company domains" description="Prove which email domains your company owns. Rovara uses a verified domain to tell which email addresses are your company's." />
  <p className="rv-admin-note">Add a domain, then publish the DNS record shown for it at your DNS provider. Rovara checks for the record when you press Check now and once a day. If the record is gone for 3 days in a row, the domain is lost and stops counting. A domain belongs to one company only.</p>
  <form onSubmit={event => { event.preventDefault();if (typed.trim() !== "") void add(); }}>
   <TextField label="Domain" hint="For example example.com, without https:// or a path." value={typed} onChange={event => { setTyped(event.target.value); }} autoComplete="off" spellCheck={false} maxLength={300} />
   <Button type="submit" variant="primary" busy={busy === "add"} disabled={busy !== undefined || typed.trim() === ""}>Add domain</Button>
  </form>
  {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}</p>}
  {read.isPending ? <Skeleton label="Loading company domains" /> : read.isError ? <div><p role="alert">Couldn't load the company's domains.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : read.data.domains.length === 0 ? <p>No domains yet.</p> : <ul className="rv-admin-domains" aria-label="Company domains">
   {read.data.domains.map(entry => <li key={entry.domain} aria-label={entry.domain}>
    <h2><VisibleText text={entry.domain} /></h2>
    <p><strong>{STATE_WORDS[entry.state] ?? "Unknown"}</strong>{entry.state === "verified" && entry.verifiedAt !== undefined && <> since {day(entry.verifiedAt)}</>}</p>
    {entry.state === "verified" && entry.missingSince !== undefined && <p role="status">The record has not been found since {day(entry.missingSince)}. The domain is lost if it stays gone for {read.data.lostAfterDays} days in a row.</p>}
    {entry.state === "lost" && <p role="status">The record was gone for {read.data.lostAfterDays} days, so this domain no longer counts. Put the record back and press Check now to verify it again.</p>}
    {entry.state === "pending" && <p className="rv-muted">Adding a domain does not stop anyone else from adding it. The domain is yours once your record is found in DNS.</p>}
    {entry.state !== "verified" && <>
     <p>Add this DNS record:</p>
     <dl className="rv-admin-record"><dt>Type</dt><dd><code>{entry.record.type}</code></dd><dt>Name</dt><dd><code>{entry.record.name}</code></dd><dt>Value</dt><dd><code>{entry.record.value}</code></dd></dl>
    </>}
    {entry.lastCheckedAt !== undefined && <p className="rv-muted">Last checked {day(entry.lastCheckedAt)}{entry.lastResult !== undefined && RESULT_WORDS[entry.lastResult] !== undefined && <>. {RESULT_WORDS[entry.lastResult]}</>}</p>}
    {note?.domain === entry.domain && note.text !== "" && <p role="status">{note.text}</p>}
    <div className="rv-actions">
     <Button busy={busy === "check:" + entry.domain} disabled={busy !== undefined} onClick={() => { void check(entry.domain); }}>Check now</Button>
     <Button variant="danger" disabled={busy !== undefined} onClick={() => { setRemoving(entry); }}>Remove</Button>
    </div>
   </li>)}
  </ul>}
  <Dialog open={removing !== undefined} onOpenChange={open => { if (!open) setRemoving(undefined); }} title="Remove this domain?" description="Rovara stops counting email addresses at this domain as your company's. Anything that relies on the domain being verified stops working until you add and verify it again.">
   {removing !== undefined && <><p><VisibleText text={removing.domain} /></p><div className="rv-actions"><Button onClick={() => { setRemoving(undefined); }}>Cancel</Button><Button variant="danger" busy={busy === "remove:" + removing.domain} disabled={busy !== undefined} onClick={() => { void remove(removing.domain); }}>Remove domain</Button></div></>}
  </Dialog>
 </section>;
}
