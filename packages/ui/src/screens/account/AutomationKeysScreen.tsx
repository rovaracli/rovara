import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createScriptTokenApi, scriptTokenError } from "../../api/script-tokens.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { AdminSection } from "../admin/parts.js";
import { useNav } from "./use-nav.js";
import { CreateAutomationKey } from "./CreateAutomationKey.js";
import "../admin/admin.css";

const when = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" });
export function AutomationKeysScreen() {
 const host = useAppHost(), api = useMemo(() => createScriptTokenApi(host), [host]), nav = useNav();
 const keys = useQuery({ queryKey: ["account", "script-tokens"], queryFn: () => api.list(), retry: false, gcTime: 0 });
 const canCreate = keys.data?.canCreate === true;
 const [revoking, setRevoking] = useState<string>(), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>();
 const target = keys.data?.tokens.find(key => key.tokenId === revoking);
 async function revoke() {
  if (target === undefined || busy) return;
  setBusy(true); setProblem(undefined);
  try { await api.revoke(target.tokenId); setRevoking(undefined); await keys.refetch(); }
  catch (error) { setProblem(scriptTokenError(error, "revoke")); }
  finally { setBusy(false); }
 }
 return <section aria-label="Automation keys">
  <PageHeader focusOnMount title="Automation keys" description="Keys for your scripts and CI. Each key acts as its creator on its selected projects and permissions." />
  <p><Link to="/app/account">Your account</Link></p>
  <AdminSection title="Keys" actions={canCreate && nav !== undefined ? <Button onClick={() => setCreating(true)}>Create automation key</Button> : undefined}>
   {keys.isPending ? <Skeleton label="Loading automation keys" /> : keys.isError ? <div role="alert"><p>{scriptTokenError(keys.error, "load")}</p><Button onClick={() => { void keys.refetch(); }}>Try again</Button></div>
    : keys.data.tokens.length === 0 ? <p>No automation keys.</p>
    : <ul className="rv-passkeys" aria-label="Automation keys list">{keys.data.tokens.map(key => <li key={key.tokenId}><div>
     <b><VisibleText text={key.name} /></b> <code>{key.hint}</code> <span>{key.status}</span>
     <p>Projects: <VisibleText text={key.projects.join(", ")} /> · Permissions: {key.permissions.join(", ")}</p>
     <p>Created {when(key.createdAt)} · Expires {when(key.expiresAt)} · {key.lastUsedAt === undefined ? "Never used" : `Last used ${when(key.lastUsedAt)}`}</p>
     <p>{key.mine ? "Created by you" : <VisibleText text={key.createdBy ?? "Another person"} />}</p>
    </div>{key.status === "active" && <Button aria-label={`Revoke ${key.name}`} variant="danger" onClick={() => { setProblem(undefined); setRevoking(key.tokenId); }}>Revoke</Button>}</li>)}</ul>}
  </AdminSection>
  <Dialog title="Revoke this automation key?" description="Scripts using this key will stop working. This can't be undone." open={target !== undefined} onOpenChange={open => { if (!open) { setRevoking(undefined); setProblem(undefined); } }}>
   <Button variant="danger" busy={busy} onClick={() => { void revoke(); }}>Revoke key</Button><Button disabled={busy} onClick={() => setRevoking(undefined)}>Keep key</Button>
   {problem && <p role="alert">{problem}</p>}
  </Dialog>
  {canCreate && creating && nav !== undefined && <Dialog title="Create automation key" open onOpenChange={setCreating}><CreateAutomationKey who={nav.me.developerId} onCreated={() => { void keys.refetch(); }} /></Dialog>}
 </section>;
}
