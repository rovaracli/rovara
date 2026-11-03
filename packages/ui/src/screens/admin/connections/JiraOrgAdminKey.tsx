import { useMemo, useState } from "react";
import { JiraOrgAdminMutationBodySchema, JiraOrgAdminResultReaderSchema, type JiraOrgAdminMutationBody } from "@agentx/contracts/web";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";

const PATH = "/v1/app/org/jira-org-admin";
type Failure = { message: string; reauth: boolean };

/** What a refusal says, in fixed words: nothing the person typed (and no text from the server) is shown back. */
function failureOf(caught: unknown): Failure {
  if (!(caught instanceof ApiError)) return { message: "That change was not made. Try again.", reauth: false };
  if (caught.code === "REAUTH_REQUIRED") return { message: "Sign in again to change the key. This needs a sign-in within the last 10 minutes.", reauth: true };
  if (caught.code === "AUDIT_UNAVAILABLE") return { message: "This change needs the audit log, which is not available right now. Nothing was changed.", reauth: false };
  if (caught.code === "FORBIDDEN") return { message: "Only a company owner or admin, in the browser, can change the key.", reauth: false };
  if (caught.code === "NOT_FOUND") return { message: "That Jira connection, or this setting, is not available for this company.", reauth: false };
  if (caught.status === 400) return { message: "Check the key and the organization id, then try again. Save the connection's email and API token first if you have not.", reauth: false };
  return { message: "That change was not made. Try again.", reauth: false };
}

/**
 * The Jira organization admin key (DV-1). WRITE-ONLY: the key is typed into a password field, sent once, cleared from the page as soon as it is sent, and never shown back (no call returns it). The key and the
 * Atlassian organization id go together, so Save needs both. Only a company owner or admin sees this; the broker also needs a sign-in within the last 10 minutes and writes an audit record.
 */
export function JiraOrgAdminKey({ connections }: { connections: ReadonlyArray<{ connectionId: string; label: string }> }) {
  const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
  const [connectionId, setConnectionId] = useState(connections[0]?.connectionId ?? ""), [key, setKey] = useState(""), [orgId, setOrgId] = useState("");
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>(), [receipt, setReceipt] = useState<string>();
  if (connections.length === 0) return null;
  const chosen = connections.some(connection => connection.connectionId === connectionId) ? connectionId : connections[0]!.connectionId;
  const ready = key.trim() !== "" && orgId.trim() !== "";
  async function send(body: JiraOrgAdminMutationBody, done: string) {
    const checked = JiraOrgAdminMutationBodySchema.safeParse(body);
    if (!checked.success) { setFailure({ message: "Check the key and the organization id, then try again.", reauth: false });return; }
    setBusy(true);setFailure(undefined);setReceipt(undefined);
    // The key leaves the page the moment it is sent, whatever the answer: it is never kept for a retry.
    setKey("");setOrgId("");
    try {
      // One request per press: a repeated press with the same request id is one change.
      await api.sendAnswer("POST", PATH, checked.data, JiraOrgAdminResultReaderSchema, { retry: "never" });
      setReceipt(done);
    } catch (caught) { setFailure(failureOf(caught)); } finally { setBusy(false); }
  }
  return <section aria-labelledby="jira-org-admin-title">
    <h3 id="jira-org-admin-title">Jira organization admin key</h3>
    <p>Optional. A read-only Atlassian organization admin API key lets Rovara see which Jira accounts your company manages, so it can link people to their tickets automatically if you turn that on (see Tracker people). Without it, you map Jira people by hand. Give the key and the organization id together.</p>
    <p>Rovara keeps the key like a password and never shows it again. This is the one place on this page where you type a credential.</p>
    {failure !== undefined && <p role="alert"><VisibleText text={failure.message} />{failure.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}</p>}
    {receipt !== undefined && <p role="status">{receipt}</p>}
    <form onSubmit={event => { event.preventDefault();if (ready && !busy) void send({ action: "set", requestId: crypto.randomUUID(), connectionId: chosen, orgAdminKey: key.trim(), atlassianOrgId: orgId.trim() }, "Saved. Rovara does not show the key again."); }}>
      {connections.length > 1 && <div className="rv-field"><label htmlFor="jira-org-admin-connection">Jira connection</label><select id="jira-org-admin-connection" value={chosen} onChange={event => setConnectionId(event.target.value)}>{connections.map(connection => <option key={connection.connectionId} value={connection.connectionId}>{visibleText(connection.label)}</option>)}</select></div>}
      <TextField label="Organization admin API key" type="password" autoComplete="off" spellCheck={false} maxLength={8192} hint="Read-only, with the read:accounts:admin scope. Create it in admin.atlassian.com." value={key} onChange={event => setKey(event.target.value)} />
      <TextField label="Atlassian organization id" autoComplete="off" spellCheck={false} maxLength={64} hint="The id in the admin.atlassian.com address of your organization." value={orgId} onChange={event => setOrgId(event.target.value)} />
      <Button type="submit" variant="primary" busy={busy} disabled={!ready}>Save key</Button>{" "}
      <Button disabled={busy} onClick={() => { void send({ action: "clear", requestId: crypto.randomUUID(), connectionId: chosen }, "Removed. Rovara no longer holds an organization admin key for this connection."); }}>Remove key</Button>
    </form>
  </section>;
}
