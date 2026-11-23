// Automation keys (board automation-keys / mocks 25d, 25e, 19o). G5 ship: the list is read like the rest of G5 (identity checked before and after, no cache kept, no retry,
// metadata only: a secret in an answer is dropped by the schema). Revoke stays behind its confirm with one send, and Create is offered only on Code's explicit canCreate grant,
// in the unchanged CreateAutomationKey form, which owns the show-once secret (component state only; never a URL, storage, cache or log).
// The Create dialog (and so the secret) is pinned beside the read frame (ReadEntry), not drawn by this page: a failed re-read of the list, or of who you are, never removes it;
// only the person dismissing it does. Only the Create BUTTON depends on a good read.
// While the list cannot be read (or is only the last good read), Revoke and Create are not offered: nothing destructive is done on a list that may be out of date.
// Reads follow the SHARED policy (servedReadState + isAccessEnded, DEC 254zzz324): a failed re-read keeps the last list with the one Reconnecting line; only 401, 403, 404 clear it.
// A revoke that went through says so even when the list cannot be read again right after it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ScriptTokenMetadataListSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createScriptTokenApi, scriptTokenError } from "../../api/script-tokens.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { PageHeader } from "../../design/PageHeader.js";
import { VisibleText } from "../../design/VisibleText.js";
import { DataTable } from "../../design/DataTable.js";
import { CreateAutomationKey } from "../account/CreateAutomationKey.js";
import { ErrorBlock, Foot, GuardedSubmit, Loading, Notice, Pill, ReadFrom, Row, Rows, Section } from "./parts.js";
import { COULDNT_REFRESH, STALE_REFUSAL, servedFacts, useNoteWrite, useReadIdentity, usePin, useScopedRead, useWritable, useWroteSafe } from "./read-model.js";
import { ReconnectingLine, useReconnectingLine } from "./reconnecting.js";

type Key = ReturnType<typeof ScriptTokenMetadataListSchema.parse>["tokens"][number];
const PERMISSION = { read: "can read tasks", start: "can start tasks", lessons: "can read team lessons", wiki: "can read the wiki" } as const;
const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
/** The viewer's own local time with its zone; the exact UTC value stays in the tooltip. */
const when = (value: string) => <time dateTime={value} title={value}>{new Date(value).toLocaleString(undefined, { timeZoneName: "short" })}</time>;
function KeyState({ keyItem }: { keyItem: Key }) {
 if (keyItem.status === "active") return <Pill tone="ok" state="active">Active</Pill>;
 return <Pill tone="idle" state={keyItem.status}>{keyItem.status === "revoked" ? "Revoked" : "Expired"}</Pill>;
}
export function AutomationKeysReadScreen() {
 const me = useReadIdentity();
 const host = useAppHost(), api = useMemo(() => createScriptTokenApi(host), [host]);
 const keys = useScopedRead("/v1/app/script-tokens", ScriptTokenMetadataListSchema);
 const failed = keys.isError || keys.failureCount > 0;
 // What is on screen: the shared policy's facts (the last good read stays, also during a re-read, with one Reconnecting line after a failed one). Writes are offered only on a good read.
 const { data: shown, staleSince } = servedFacts(keys), line = useReconnectingLine(staleSince);
 // The one write rule (useWritable): who you are and the list are both fresh reads. The Create form is pinned beside the frame, so its send-time check reads this live.
 const fresh = useWritable(keys) && shown !== undefined;
 const freshNow = useRef(false);
 useEffect(() => { freshNow.current = fresh; return () => { freshNow.current = false; }; });
 const canCreate = fresh && shown?.canCreate === true;
 const pin = usePin(), cache = useQueryClient(), noteWrite = useNoteWrite(), wroteSafe = useWroteSafe();
 const [revoking, setRevoking] = useState<string>(), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>(), [revoked, setRevoked] = useState<{ name: string; refreshFailed: boolean }>();
 const target = shown?.tokens.find(key => key.tokenId === revoking);
 async function revoke() {
  if (target === undefined || busy) return;
  if (!fresh) { setProblem(STALE_REFUSAL); return; }
  setBusy(true); setProblem(undefined); setRevoked(undefined);
  try { await api.revoke(target.tokenId); noteWrite(); setRevoking(undefined); const name = target.name; setRevoked({ name, refreshFailed: false }); const again = await keys.refetch(); setRevoked({ name, refreshFailed: again.isError }); }
  catch (error) { setProblem(scriptTokenError(error, "revoke")); }
  finally { setBusy(false); }
 }
 // The list is read again by key (never by this page's own query), so the dialog does not depend on this page staying mounted.
 const refreshList = () => { noteWrite(); void cache.invalidateQueries({ predicate: entry => entry.queryKey[0] === "g5-account-setup" && entry.queryKey.includes("/v1/app/script-tokens") }); };
 const openCreate = () => { pin(<Dialog title="Create automation key" className="g5-dialog g5-create-key" open onOpenChange={open => { if (!open) pin(null); }}><GuardedSubmit allowed={() => freshNow.current}><CreateAutomationKey onCreated={refreshList} /></GuardedSubmit></Dialog>); };
 const create = canCreate ? <Button variant="primary" onClick={openCreate}>Create automation key</Button> : null;
 return <>
  <PageHeader title="Automation keys" breadcrumbs={[{ label: "Account", href: "/app/account" }, { label: "Automation keys" }]} description="Keys that let scripts act as you in chosen projects" />
  <ReconnectingLine />
  <section className="g5-main g5-stack" aria-label="Automation keys">
   {revoked !== undefined && <Notice tone="ok" testId="key-revoked-notice"><VisibleText text={revoked.name} /> is revoked.{revoked.refreshFailed ? ` ${COULDNT_REFRESH}` : ""}</Notice>}
   {shown === undefined
    ? failed ? <><p className="g5-note" role="status">Can&apos;t tell yet what your automation keys are.</p><ErrorBlock code="AUTOMATION-KEYS-READ-FAILED" happened={scriptTokenError(keys.error, "load")} {...(wroteSafe === undefined ? {} : { safe: wroteSafe })} busy={keys.isFetching} onRetry={() => { void keys.refetch(); }} /></>
     : <Loading>Loading automation keys… Can&apos;t tell yet.</Loading>
    : <>
     {line}
     {shown.tokens.length === 0
      ? <section className="g5-card" aria-label="No automation keys"><p><strong>You have no automation keys.</strong> A key lets a script, such as a CI job, start tasks as you in one project. You don&apos;t need one to use Rovara from the web or Slack. <ReadFrom at={keys.dataUpdatedAt} /></p>{create !== null && <div className="g5-actions">{create}</div>}</section>
      : <>
       <div className="g5-summary-row"><p className="g5-summary">{plural(shown.tokens.length, "key")} · {shown.tokens.filter(key => key.status === "active").length} active · <ReadFrom at={keys.dataUpdatedAt} /> A key works only in the projects it names and only with the permissions shown.</p>{create}</div>
       <div className="g5-table g5-keys">
        <DataTable<Key> caption="Automation keys" rows={shown.tokens} rowKey={key => key.tokenId} columns={[
         { key: "key", title: "Key", render: key => <><strong><VisibleText text={key.name} /></strong><span className="g5-sub"><VisibleText text={key.projects.join(", ")} /> · {key.permissions.map(permission => PERMISSION[permission]).join(", ")} · {key.mine ? "created by you" : <>created by <VisibleText text={key.createdBy ?? "another person"} /></>} · <span className="g5-nb">ends in <code>{key.hint}</code></span></span><span className="g5-sub">Created {when(key.createdAt)} · Expires {when(key.expiresAt)}</span></> },
         { key: "used", title: "Last used", render: key => key.lastUsedAt === undefined ? "Never used" : <>Last used {when(key.lastUsedAt)}</> },
         { key: "state", title: "State", render: key => <span className="g5-key-state"><KeyState keyItem={key} />{fresh && key.status === "active" && <Button variant="quiet" aria-label={`Revoke ${key.name}`} onClick={() => { setProblem(undefined); setRevoking(key.tokenId); }}>Revoke</Button>}</span> },
        ]} />
       </div>
       <Foot>Rovara can&apos;t see where a key is stored or which other scripts hold it. A secret is shown once, when its key is created, and is not kept in a form anyone can read.</Foot>
      </>}
     <Section title="What these are, and are not"><Rows>
      <Row mark="ok" title="A key acts as you" detail="Tasks it starts are owned by you. It can never approve a plan or a merge: those are button presses by a person." aside="In its projects, with its permissions" />
      <Row mark="none" title="Not a sign-in method" detail="Revoking a key never signs you out." aside="Account, Sign-in methods" />
      <Row mark="none" title={<>Not <VisibleText text={me.org.name} />&apos;s AI key or a connection</>} detail="Those belong to the company and are managed by its owners." aside="Company, Connections" />
     </Rows></Section>
    </>}
  </section>
  <Dialog className="g5-dialog" title="Revoke this automation key?" description="Scripts using this key will stop working. This can't be undone." open={target !== undefined} onOpenChange={open => { if (!open) { setRevoking(undefined); setProblem(undefined); } }}>
   {target !== undefined && <p className="g5-dialog-lede"><VisibleText text={target.name} /> · <code>{target.hint}</code></p>}
   <div className="g5-dialog-actions"><Button variant="danger" busy={busy} onClick={() => { void revoke(); }}>Revoke key</Button><Button disabled={busy} onClick={() => setRevoking(undefined)}>Keep key</Button></div>
   {problem && <p role="alert" className="g5-dialog-alert">{problem}</p>}
  </Dialog>
 </>;
}
