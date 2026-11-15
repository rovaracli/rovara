// Sign-in factors (Hybrid 1, DEC 223): where a person's fresh sign-in code goes (their confirmation email) and their passkeys, for company admins.
// Setting a person's confirmation email and removing their passkeys are sensitive: each shows the fresh sign-in step (Code's step-up page) first, and Code checks the
// admin's own step-up on its route. The page's own address carries the person and the action, so coming back from the step-up reopens the same step.
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
import { isNotConnected, memberFactorEmailPath, memberPasskeysPath, needsStepUp } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { DataTable } from "../../../design/DataTable.js";
import { Dialog } from "../../../design/Dialog.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { useAdminRead } from "../models/read.js";
import { AdminSection, FreshSignIn, NotConnected, forgetConfirmed, useJustConfirmed } from "../parts.js";

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/u;
type Action = "email" | "passkeys";
const roleNames: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", auditor: "Auditor" };

export function SignInFactorsScreen() {
 const { role, developerId } = useAdminContext(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useAdminRead("factor-members", "/v1/app/org/members", AppOrgMembersResponseReaderSchema);
 const [params, setParams] = useSearchParams(), confirmed = useJustConfirmed(developerId);
 const person = params.get("person"), action = params.get("do") === "email" ? "email" : params.get("do") === "passkeys" ? "passkeys" : undefined;
 const [email, setEmail] = useState(""), [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [result, setResult] = useState<{ kind: "ok" | "failed" | "not_connected" | "step_up"; text: string }>();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Sign-in factors" /><p role="alert">Only current company owners and admins can manage sign-in factors.</p></section>;
 const target = read.data?.members.find(member => member.developerId === person);
 function open(member: string, what: Action) { setResult(undefined); setEmail(""); setParams({ person: member, do: what }, { replace: true }); }
 function close() { setResult(undefined); setParams({}, { replace: true }); }
 async function run() {
  if (target === undefined || action === undefined) return;
  setBusy(true); setResult(undefined);
  try {
   if (action === "email") await api.sendAnswer("PUT", memberFactorEmailPath(target.developerId), { requestId: crypto.randomUUID(), email: email.trim() }, { parse: body => body }, { retry: "never" });
   else await api.sendAnswer("DELETE", memberPasskeysPath(target.developerId), {}, { parse: body => body }, { retry: "never" });
   setResult({ kind: "ok", text: action === "email" ? "Changed. The old address was told first." : "Removed. The person was told." });
  } catch (error) {
   if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); setResult({ kind: "step_up", text: "" }); }
   else if (isNotConnected(error)) setResult({ kind: "not_connected", text: "" });
   else setResult({ kind: "failed", text: error instanceof ApiError ? error.message : "Couldn't finish that. Try again." });
  } finally { setBusy(false); }
 }
 const ready = confirmed && !stale, what = action === "email" ? "change this person's confirmation email" : "remove this person's passkeys";
 return <section><PageHeader focusOnMount title="Sign-in factors" description="A fresh sign-in asks for a passkey or a code sent to the person's confirmation email. Set the email or remove passkeys here when someone loses access." />
  {read.isPending ? <Skeleton label="Loading company members" />
   : read.data === undefined ? <div role="alert" className="rv-banner rv-banner-danger"><span><b>{isNotConnected(read.error) ? "People aren't connected to Rovara Code yet." : "Couldn't load company members."}</b></span><Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Try again</Button></div>
   : <DataTable caption="Sign-in factors by person" rows={read.data.members} rowKey={member => member.developerId} columns={[
     { key: "person", title: "Person", render: member => <b><VisibleText text={member.name} /></b> },
     { key: "role", title: "Role", render: member => roleNames[member.role] ?? "Unavailable" },
     { key: "email", title: "Confirmation email", render: () => <span className="rv-muted">Shown only to the person</span> },
     { key: "actions", title: "Actions", render: member => member.developerId === developerId ? <Link to="/app/account">Your account</Link> : member.role === "owner" && role !== "owner" ? <span className="rv-muted">Owners only</span> : <span className="rv-actions"><Button onClick={() => { open(member.developerId, "email"); }} aria-label={`Set confirmation email for ${member.name}`}>Set email</Button><Button onClick={() => { open(member.developerId, "passkeys"); }} aria-label={`Remove passkeys for ${member.name}`}>Remove passkeys</Button></span> },
    ]} />}
  <AdminSection title="How a fresh sign-in works"><p>The confirmation email is taken from a person's first sign-in. Changing it at Slack, Google or GitHub later never moves it. Only a company admin can change it, and the old address is told first. Passkeys are added by the person, after an emailed code.</p></AdminSection>
  <Dialog title={action === "email" ? `Set confirmation email${target === undefined ? "" : " for " + target.name}` : `Remove passkeys${target === undefined ? "" : " for " + target.name}`} description={action === "email" ? "Where this person's sign-in codes go." : "The person can add a new one after an emailed code."} open={target !== undefined && action !== undefined} onOpenChange={next => { if (!next) close(); }}>
   {!ready ? <FreshSignIn action={what} refused={stale} /> : <>
    <FreshSignIn action={what} done />
    {action === "email" ? <><TextField label="New confirmation email" type="email" autoComplete="off" value={email} onChange={event => { setEmail(event.target.value); }} hint="The old address is told before the change. If it can't be told, nothing changes." /><Button variant="primary" busy={busy} disabled={!EMAIL.test(email.trim())} onClick={() => { void run(); }}>Change confirmation email</Button></>
     : <Button variant="danger" busy={busy} onClick={() => { void run(); }}>Remove all passkeys</Button>}
   </>}
   {result?.kind === "ok" && <p role="status">{result.text}</p>}
   {result?.kind === "failed" && <p role="alert"><VisibleText text={result.text} /></p>}
   {result?.kind === "not_connected" && <NotConnected what="Sign-in factors" />}
  </Dialog>
 </section>;
}
