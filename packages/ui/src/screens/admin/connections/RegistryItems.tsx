// UX3: the saved connections of a card (Linear, Jira, cloud, tools), each with "Check it works" and Remove, and the form that adds a Linear or Jira connection. The
// secret is write-only: typed into a password field, sent once, cleared from the page whatever the answer, never shown back. Adding checks it at once.
import { useState } from "react";
import { z } from "zod";
import { useAppHost } from "../../../host.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { Select } from "../../../design/Select.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { causeText, connectedByWords, connectionSummary, STATE_WORDS, type RegistryConnection } from "./connection-state.js";
const Answer = z.object({ ok: z.boolean(), message: z.string().max(2000).optional() });
const Created = z.object({ connection: z.object({ connectionId: z.string().max(100) }).passthrough() }).passthrough();
const Anything = { parse: (value: unknown) => value };
export type CheckResult = { state: "busy" } | { state: "ok" } | { state: "failed"; message: string };
/** Runs "Check it works" for one saved connection and reports a tick or exactly what the vendor said. */
export async function runCheck(host: ReturnType<typeof useAppHost>, connectionId: string): Promise<CheckResult> {
  try {
    const result = await createApiClient(host).send("POST", `/v1/app/connections/${connectionId}/check`, { requestId: crypto.randomUUID() }, Answer, { retry: "never" });
    const value = result.kind === "done" ? result.value : undefined;
    return value?.ok === true ? { state: "ok" } : { state: "failed", message: causeText(value?.message) };
  } catch (failure) { return { state: "failed", message: failure instanceof ApiError ? causeText(failure.message) : "the check didn't finish. Try again" }; }
}
export function RegistryItems({ connections, names, canChange, checks, onCheck, onChanged, usedBy }: {
  connections: readonly RegistryConnection[]; names: ReadonlyMap<string, string> | undefined; canChange: boolean; checks: Readonly<Record<string, CheckResult>>; onCheck: (connectionId: string) => void; onChanged: () => void;
  /** The words for the projects that use one connection (exact, from the usage read); none while that was not read. */
  usedBy?: (connection: RegistryConnection) => string | undefined;
}) {
  const host = useAppHost();
  const [removing, setRemoving] = useState<RegistryConnection>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function remove() {
    if (removing === undefined) return;
    setBusy(true);setError(undefined);
    try { await createApiClient(host).send("DELETE", `/v1/app/connections/${removing.connectionId}`, { requestId: crypto.randomUUID() }, Anything, { retry: "never" });setRemoving(undefined);onChanged(); }
    catch (failure) { setError(failure instanceof ApiError ? causeText(failure.message) : "Couldn't remove it. Refresh and try again."); } finally { setBusy(false); }
  }
  if (connections.length === 0) return null;
  return <>
    <ul className="rv-conn-items">{connections.map(connection => {
      const result = checks[connection.connectionId];
      const summary = connectionSummary(connection, result?.state === "failed" ? result.message : undefined);
      const shown = result?.state === "ok" ? { ...summary, state: "connected" as const } : summary;
      return <li key={connection.connectionId} className="rv-conn-item">
        <p><strong><VisibleText text={connection.label} /></strong> · {STATE_WORDS[shown.state]}</p>
        <p className="rv-muted">{connectedByWords(connection.createdBy, connection.createdAt, names)}.{connection.access === "read_write" ? " It can read and write." : " It can only read."}{connection.identity === "personal" ? " It uses a personal key." : ""}</p>
        {usedBy?.(connection) !== undefined && <p className="rv-muted">Used by: <VisibleText text={usedBy(connection)!} /></p>}
        {canChange && <div className="rv-conn-buttons"><Button busy={result?.state === "busy"} onClick={() => { onCheck(connection.connectionId); }}>Check it works</Button><Button variant="quiet" onClick={() => { setError(undefined);setRemoving(connection); }}>Remove</Button></div>}
        {result?.state === "ok" && <p role="status">✓ It works. Rovara reached the service with the saved key.</p>}
        {result?.state === "failed" && <p role="alert">It didn't work: <VisibleText text={result.message} /></p>}
        {result === undefined && shown.state === "attention" && <p>{shown.why} {shown.fix}</p>}
      </li>;
    })}</ul>
    <Dialog title="Remove this connection?" description="Rovara stops using it at once. Its key is scheduled for deletion and can be recovered for 7 days." open={removing !== undefined} onOpenChange={open => { if (!open) setRemoving(undefined); }}>
      {removing !== undefined && <p>Remove <VisibleText text={removing.label} />?</p>}
      <Button variant="danger" busy={busy} onClick={() => { void remove(); }}>Remove connection</Button>{error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
    </Dialog>
  </>;
}
type Kind = "linear" | "jira";
const VENDOR: Readonly<Record<Kind, string>> = { linear: "Linear", jira: "Jira" };
/** Add a Linear or Jira connection with plain fields, then check it at once (one request, one check). */
export function AddTracker({ kind, onAdded }: { kind: Kind; onAdded: (connectionId: string) => void }) {
  const host = useAppHost();
  const [label, setLabel] = useState(`${VENDOR[kind]} for ${kind === "linear" ? "our team" : "our site"}`), [key, setKey] = useState(""), [email, setEmail] = useState(""), [site, setSite] = useState("");
  const [identity, setIdentity] = useState<"service" | "personal">("service"), [access, setAccess] = useState<"read" | "read_write">("read");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const jira = kind === "jira", ready = label.trim() !== "" && key.trim() !== "" && (!jira || (email.trim() !== "" && site.trim() !== ""));
  const changed = (set: (value: string) => void) => (event: { target: { value: string } }) => { set(event.target.value);setRequestId(crypto.randomUUID()); };
  async function add() {
    if (!ready || busy) return;
    setBusy(true);setError(undefined);
    const siteUrl = site.trim().startsWith("https://") ? site.trim() : `https://${site.trim().replace(/^\/+/, "")}${site.includes(".") ? "" : ".atlassian.net"}`;
    const connection = { type: kind, label: label.trim(), access, identity, ...(jira ? { siteUrl } : {}) };
    const secret = jira ? { email: email.trim(), apiToken: key.trim() } : { apiKey: key.trim() };
    try {
      const result = await createApiClient(host).send("POST", "/v1/app/connections", { requestId, connection, secret }, Created, { retry: "never" });
      if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara couldn't confirm the connection was added. Refresh before trying again.");
      setRequestId(crypto.randomUUID());onAdded(result.value.connection.connectionId);
    } catch (failure) { setError(failure instanceof ApiError ? causeText(failure.message) : "Couldn't add the connection. Try again."); }
    finally { setKey("");setBusy(false); }
  }
  return <form className="rv-conn-add" onSubmit={event => { event.preventDefault();void add(); }}><h3>Add {VENDOR[kind]}</h3>
    <TextField label="Name" hint="What your team sees." value={label} maxLength={64} onChange={changed(setLabel)} />
    {jira && <TextField label="Jira site" hint="For example acme, or https://acme.atlassian.net." value={site} autoComplete="off" spellCheck={false} onChange={changed(setSite)} />}
    {jira && <TextField label="Atlassian account email" hint="The account the API token belongs to." type="email" value={email} autoComplete="off" spellCheck={false} onChange={changed(setEmail)} />}
    <TextField label={jira ? "API token" : "API key"} type="password" hint="Sent once to be stored securely. Rovara never shows it again." value={key} autoComplete="new-password" spellCheck={false} onChange={event => { setKey(event.target.value); }} />
    <Select label="Whose account is it" value={identity} onValueChange={value => { setIdentity(value as "service" | "personal");setRequestId(crypto.randomUUID()); }} options={[{ value: "service", label: `A service account only Rovara uses (recommended)` }, { value: "personal", label: "A person's own account" }]} />
    <Select label="What Rovara may do" value={access} onValueChange={value => { setAccess(value as "read" | "read_write");setRequestId(crypto.randomUUID()); }} options={[{ value: "read", label: "Read only" }, { value: "read_write", label: "Read and write (comment, create tickets)" }]} />
    <Button type="submit" variant="primary" busy={busy} disabled={!ready}>Add and check it works</Button>{error !== undefined && <p role="alert">{error}</p>}</form>;
}
