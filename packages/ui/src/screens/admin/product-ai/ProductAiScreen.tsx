// Product AI keys (B7, Hybrid 1 admin area): a project's own AI Studio key for the calls its tests make, its eval budget per stage run, and the
// approved eval spend the model gateway holds a stage against. The key is write-only: it is typed once, sent, and never shown back (Cloud answers
// only whether one is connected). Every change needs a fresh sign-in, which the server checks too; only the project's admin or a company admin may
// change these. Vertex AI connections come from their own page (not here).
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PROJECT_NAME, productAiPath, readProductAi, usdToMicros, type ProductAiRead } from "../../../api/admin-product-ai.js";
import { isNotConnected, needsStepUp } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { SecretField } from "../../../design/SecretField.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, FreshSignIn, NotConnected, forgetConfirmed, useJustConfirmed } from "../parts.js";

const reader = { parse: readProductAi };
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";

export function ProductAiScreen() {
 const [typed, setTyped] = useState(""), [project, setProject] = useState<string>();
 return <section><PageHeader focusOnMount title="Product AI keys" description="A project's own AI Studio key for the calls its tests make, and what its evals may spend. Keys are write-only: Rovara uses them but never shows them." />
  <form onSubmit={event => { event.preventDefault(); if (PROJECT_NAME.test(typed.trim())) setProject(typed.trim()); }}>
   <TextField label="Project" value={typed} onChange={event => { setTyped(event.target.value); }} hint="The project's name, as on the Projects page." {...(typed !== "" && !PROJECT_NAME.test(typed.trim()) ? { error: "Lowercase letters, digits and hyphens, starting with a letter." } : {})} />
   <Button type="submit" disabled={!PROJECT_NAME.test(typed.trim())}>Open</Button>
  </form>
  {project !== undefined && <Project key={project} project={project} />}
 </section>;
}

function Project({ project }: { project: string }) {
 const read = useAdminRead(`product-ai-${project}`, productAiPath(project), reader, { stable: true });
 if (read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501) return <AdminSection title="Product AI"><NotConnected what="Product AI keys" /></AdminSection>;
 return <ReadSection read={read} label={`Product AI for ${project}`}>{settings => <Settings settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>;
}

function Settings({ settings, reload }: { settings: ProductAiRead; reload: () => void }) {
 const { developerId } = useAdminContext(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const confirmed = useJustConfirmed(developerId);
 const [stale, setStale] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 const [calls, setCalls] = useState(String(settings.evalBudget.calls)), [usd, setUsd] = useState(String(settings.evalBudget.costMicros / 1_000_000));
 const [selection, setSelection] = useState(settings.evalApproval?.selection ?? ""), [digest, setDigest] = useState(settings.evalApproval?.inputsDigest ?? ""), [maxCalls, setMaxCalls] = useState(String(settings.evalApproval?.maxCalls ?? "")), [maxUsd, setMaxUsd] = useState(settings.evalApproval === undefined ? "" : String(settings.evalApproval.maxCostMicros / 1_000_000)), [model, setModel] = useState(settings.evalApproval?.model ?? "");
 const path = productAiPath(settings.project);
 async function send(method: "PUT" | "DELETE", where: string, body: Record<string, unknown>, done: string) {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer(method, where, { requestId: crypto.randomUUID(), expectedRevision: settings.revision, ...body }, { parse: answer => answer }, { retry: "never" });
   setNotice({ ok: true, text: done });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", `product-ai-${settings.project}`] }); reload();
  } catch (error) {
   if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); }
   else setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); }
 }
 const ready = confirmed && !stale;
 const budgetMicros = usdToMicros(usd), maxMicros = usdToMicros(maxUsd);
 const callsOk = /^\d{1,6}$/u.test(calls) && Number(calls) >= 1, maxCallsOk = /^\d{1,6}$/u.test(maxCalls) && Number(maxCalls) >= 1;
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  {!ready && <FreshSignIn action="change this project's product AI settings" refused={stale} />}
  <AdminSection title="AI Studio key" note={settings.key.connected ? "Connected" : "Not connected"}>
   {settings.key.connected ? <p>A key is connected{settings.key.updatedAt === undefined ? "" : `, last changed ${when(settings.key.updatedAt)}`}. It is never shown here.{settings.key.refusedAt === undefined ? "" : ` Google refused it at ${when(settings.key.refusedAt)}: replace it.`}</p>
    : <p>No key is connected. The project's tests can't call Gemini until one is.{settings.removedUntil === undefined ? "" : ` The last key was removed; it can be recovered until ${when(settings.removedUntil)}.`}</p>}
   {ready && <SecretField label={settings.key.connected ? "Replace the key" : "Paste the AI Studio key"} submitLabel={settings.key.connected ? "Replace key" : "Connect key"} onSubmit={value => send("PUT", `${path}/key`, { key: value.trim() }, settings.key.connected ? "Key replaced." : "Key connected.")} />}
   {ready && settings.key.connected && <p><Button busy={busy} onClick={() => { void send("DELETE", `${path}/key`, {}, "Key removed. Tests can't call Gemini until a key is connected again."); }}>Remove key</Button></p>}
  </AdminSection>
  <AdminSection title="Eval budget" note="Per stage run">
   <p>Each eval stage may hold at most <b>{settings.evalBudget.calls}</b> calls and <b><Money usd={settings.evalBudget.costMicros / 1_000_000} /></b>.</p>
   {ready && <><TextField label="Calls per stage" inputMode="numeric" value={calls} onChange={event => { setCalls(event.target.value); }} {...(callsOk ? {} : { error: "A whole number, 1 or more." })} />
    <TextField label="Spend per stage (USD)" inputMode="decimal" value={usd} onChange={event => { setUsd(event.target.value); }} {...(budgetMicros !== undefined && budgetMicros > 0 ? {} : { error: "An amount in dollars, above 0." })} />
    <Button busy={busy} disabled={!callsOk || budgetMicros === undefined || budgetMicros === 0} onClick={() => { void send("PUT", `${path}/eval-budget`, { calls: Number(calls), costMicros: budgetMicros }, "Eval budget saved."); }}>Save eval budget</Button></>}
  </AdminSection>
  <AdminSection title="Approved eval spend" note={settings.evalApproval === undefined ? "None" : settings.evalApproval.approvedByYou ? "Approved by you" : "Approved by another admin"}>
   {settings.evalApproval === undefined ? <p>No eval spend is approved, so the final check's eval can't hold money for this project.</p>
    : <p>Approved {when(settings.evalApproval.approvedAt)}: <code><VisibleText text={settings.evalApproval.selection} /></code>, up to {settings.evalApproval.maxCalls} calls and <Money usd={settings.evalApproval.maxCostMicros / 1_000_000} />{settings.evalApproval.model === undefined ? "" : ` on ${settings.evalApproval.model}`}. An approval counts for one day.</p>}
   {ready && <><TextField label="Question selection" value={selection} maxLength={512} onChange={event => { setSelection(event.target.value); }} />
    <TextField label="Inputs digest (SHA-256, from the eval's confirmation)" value={digest} maxLength={64} spellCheck={false} onChange={event => { setDigest(event.target.value.trim()); }} {...(digest === "" || /^[a-f0-9]{64}$/u.test(digest) ? {} : { error: "64 lowercase hex characters." })} />
    <TextField label="Most calls" inputMode="numeric" value={maxCalls} onChange={event => { setMaxCalls(event.target.value); }} />
    <TextField label="Most spend (USD)" inputMode="decimal" value={maxUsd} onChange={event => { setMaxUsd(event.target.value); }} />
    <TextField label="Model (optional)" value={model} maxLength={128} onChange={event => { setModel(event.target.value.trim()); }} />
    <p><Button variant="primary" busy={busy} disabled={selection.trim() === "" || !/^[a-f0-9]{64}$/u.test(digest) || !maxCallsOk || maxMicros === undefined || maxMicros === 0} onClick={() => { void send("PUT", `${path}/eval-approval`, { approval: { selection: selection.trim(), inputsDigest: digest, maxCalls: Number(maxCalls), maxCostMicros: maxMicros, ...(model === "" ? {} : { model }) } }, "Eval spend approved."); }}>Approve eval spend</Button>
    {settings.evalApproval !== undefined && <> <Button busy={busy} onClick={() => { void send("PUT", `${path}/eval-approval`, { approval: null }, "Approval withdrawn."); }}>Withdraw approval</Button></>}</p></>}
  </AdminSection>
 </>;
}
