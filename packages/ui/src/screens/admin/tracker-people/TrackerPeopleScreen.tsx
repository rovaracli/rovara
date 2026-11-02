import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema, TrackerPeopleMutationBodySchema, TrackerPeopleReaderSchema, TrackerPeopleResultReaderSchema, type TrackerPeopleMutationBody } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { DataTable } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";

const viaWords: Record<string, string> = { verified_email: "Matched by a verified email", admin: "Mapped by an admin", connect: "Connected", signin: "Signed in", auto: "Linked automatically" };
/** Why a person was not linked automatically, in words (the codes are the server's). */
const reasonWords: Record<string, string> = {
  switch_off: "Automatic linking is off.",
  no_email: "The tool shows no email for this person.",
  no_verified_domains: "Your company has no verified domains yet, so Rovara cannot check the email's domain. An owner can verify one on the Company domains page.",
  domain_not_verified: "The email's domain is not one your company has verified (an owner can verify it on the Company domains page).",
  guest: "This person is a guest in the tool.",
  company_control_unavailable: "Rovara cannot tell whether your company controls this account. For Jira it needs a read-only Atlassian organization admin API key saved with the connection; without one, map people by hand. For Linear, the workspace's sign-in settings could not be read.",
  not_company_controlled: "This account is not company-controlled (Linear: the workspace does not enforce your company's SAML sign-in. Jira: Atlassian does not list it as one of your managed accounts).",
  unmapped_by_admin: "An admin took this person's mapping away.",
  no_matching_member: "No company member has this exact verified sign-in email.",
};
const whyWords: Record<string, string> = { domain_company_account_exact_email: "Verified domain, company-controlled account, exact email match" };
type Failure = { message: string; reauth: boolean };

/**
 * The Linear and Jira people Rovara could not match to a company member by themselves. An admin maps each to a member of this company (or takes a mapping away). The page shows the name the tool showed and
 * the tool's id, never an email. A change needs a sign-in within the last 10 minutes; the page says so and offers to sign in again.
 */
export function TrackerPeopleScreen() {
  const { orgId, developerId, role } = useAdminContext();
  if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Tracker people" /><p role="alert">Only current company owners and admins can map tracker people.</p></section>;
  return <TrackerPeople key={`${orgId}:${developerId}`} orgId={orgId} developerId={developerId} />;
}

function TrackerPeople({ orgId, developerId }: { orgId: string; developerId: string }) {
  const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
  const [picked, setPicked] = useState<Record<string, string>>({}), [busy, setBusy] = useState<string>(), [failure, setFailure] = useState<Failure>(), [receipt, setReceipt] = useState<string>();
  useEffect(() => () => { const key = ["admin", "tracker-people", orgId, developerId];void query.cancelQueries({ queryKey: key });query.removeQueries({ queryKey: key }); }, [query, orgId, developerId]);
  const read = useQuery({ queryKey: ["admin", "tracker-people", orgId, developerId], gcTime: 0, refetchOnWindowFocus: false, queryFn: async () => {
    const [people, members] = await Promise.all([api.get("/v1/app/org/tracker-people", TrackerPeopleReaderSchema), api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema)]);
    return { people, members: members.members.map(member => ({ developerId: member.developerId, name: member.name })) };
  } });
  const names = new Map((read.data?.members ?? []).map(member => [member.developerId, member.name]));
  async function send(body: TrackerPeopleMutationBody, receiptText: string) {
    const checked = TrackerPeopleMutationBodySchema.safeParse(body);
    if (!checked.success) { setFailure({ message: "Check the person and the member, then try again.", reauth: false });return; }
    setBusy(body.action === "auto_link" ? "auto_link" : `${body.system}#${body.sourceId}`);setFailure(undefined);setReceipt(undefined);
    try {
      // One request per press: a repeated press with the same request id is one change.
      await api.sendAnswer("POST", "/v1/app/org/tracker-people", checked.data, TrackerPeopleResultReaderSchema, { retry: "never" });
      setReceipt(receiptText);await read.refetch();
    } catch (caught) {
      if (caught instanceof ApiError) setFailure({ message: caught.code === "REAUTH_REQUIRED" ? "Sign in again to make this change. Mapping people needs a sign-in within the last 10 minutes." : caught.code === "NOT_FOUND" ? "That person is not on the list any more. The list was reloaded." : caught.code === "AUDIT_UNAVAILABLE" ? "This change could not be recorded in the audit log, so it was not made. Try again later." : "That change was not made. Try again.", reauth: caught.code === "REAUTH_REQUIRED" });
      else setFailure({ message: "That change was not made. Try again.", reauth: false });
      if (caught instanceof ApiError && caught.code === "NOT_FOUND") void read.refetch();
    } finally { setBusy(undefined); }
  }
  const people = read.data?.people;
  const autoLink = people?.autoLink;
  const memberOptions = (read.data?.members ?? []).map(member => <option key={member.developerId} value={member.developerId}>{member.name}</option>);
  return <section aria-busy={read.isFetching}>
    <PageHeader focusOnMount title="Tracker people" description="People in Linear and Jira that Rovara could not match to a company member by a verified email. Map each to the member they are, so their work can be remembered and, if they ask, forgotten." />
    {receipt !== undefined && <p role="status">{receipt}</p>}
    {failure !== undefined && <p role="alert"><VisibleText text={failure.message} />{failure.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}</p>}
    {read.isPending ? <Skeleton label="Loading tracker people" /> : read.isError || people === undefined ? <div><p role="alert">{read.error instanceof ApiError && read.error.status === 404 ? "Tracker people are not turned on for this company." : read.error instanceof ApiError && read.error.status === 403 ? "You don't have permission to see tracker people." : "Couldn't load tracker people. Try again."}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
      {people.truncated && <p role="alert">The list is long, so only the first part is shown.</p>}
      <h2>Automatic linking</h2>
      <p>{autoLink?.enabled === true ? "Automatic linking is on." : "Automatic linking is off."} When it is on, Rovara links a person only if their email's domain is verified for your company's sign-in, their account is company-controlled (never a guest), and their email exactly matches a member's verified sign-in email. Everyone else is listed below with the reason. Turning it off stops new automatic links; people already linked stay until you unmap them.</p>
      {autoLink?.verifiedDomainsRecorded === false && <p className="rv-muted">Your company has no verified sign-in domains recorded yet, so nobody can be linked automatically even when this is on.</p>}
      <Button disabled={busy !== undefined} onClick={() => { void send({ action: "auto_link", requestId: crypto.randomUUID(), enabled: autoLink?.enabled !== true }, autoLink?.enabled === true ? "Automatic linking is off." : "Automatic linking is on."); }}>{autoLink?.enabled === true ? "Turn automatic linking off" : "Turn automatic linking on"}</Button>
      <h2>Not matched yet</h2>
      {people.unmatched.length === 0 ? <p>Every person Rovara found in your connected tools is matched.</p> : <DataTable caption="Tracker people not matched to a company member" rows={people.unmatched} rowKey={person => `${person.system}#${person.sourceId}`} columns={[
        { key: "tool", title: "Tool", render: person => person.tool },
        { key: "name", title: "Name in the tool", render: person => <VisibleText text={person.displayName} /> },
        { key: "id", title: "Tool id", render: person => <VisibleText text={person.sourceId} /> },
        { key: "why", title: "Why not linked", render: person => person.reason === undefined ? "Not checked yet" : reasonWords[person.reason] ?? "Not linked" },
        { key: "member", title: "Company member", render: person => { const key = `${person.system}#${person.sourceId}`;return <select aria-label={`Company member for ${person.displayName}`} className="rv-input rv-select-trigger" value={picked[key] ?? ""} onChange={event => { setPicked({ ...picked, [key]: event.target.value }); }}><option value="" disabled>Choose a member</option>{memberOptions}</select>; } },
        { key: "action", title: "Map", render: person => { const key = `${person.system}#${person.sourceId}`, chosen = picked[key];return <Button disabled={chosen === undefined || chosen === "" || busy !== undefined} onClick={() => { if (chosen !== undefined && chosen !== "") void send({ action: "map", requestId: crypto.randomUUID(), system: person.system, sourceId: person.sourceId, developerId: chosen }, `Mapped ${person.displayName} to ${names.get(chosen) ?? "the member"}.`); }}>Map</Button>; } },
      ]} />}
      <h2>Matched</h2>
      {people.linked.length === 0 ? <p>No one is matched yet.</p> : <DataTable caption="Tracker people matched to a company member" rows={people.linked} rowKey={person => `${person.system}#${person.sourceId}`} columns={[
        { key: "tool", title: "Tool", render: person => person.tool },
        { key: "name", title: "Name in the tool", render: person => <VisibleText text={person.displayName === "" ? person.sourceId : person.displayName} /> },
        { key: "member", title: "Company member", render: person => <VisibleText text={names.get(person.developerId) ?? "A former member"} /> },
        { key: "how", title: "How", render: person => (viaWords[person.via] ?? "Matched") + (person.why === undefined ? "" : ": " + (whyWords[person.why] ?? "")) },
        { key: "action", title: "Unmap", render: person => <Button disabled={busy !== undefined} onClick={() => { void send({ action: "unmap", requestId: crypto.randomUUID(), system: person.system, sourceId: person.sourceId }, `Took away the mapping of ${person.displayName === "" ? "that person" : person.displayName}.`); }}>Unmap</Button> },
      ]} />}
      <p className="rv-muted rv-admin-note">Unmapping stops new work by that person in the tool from being remembered. What was already remembered stays with the member, and is forgotten if they ask to be forgotten.</p>
    </>}
  </section>;
}
