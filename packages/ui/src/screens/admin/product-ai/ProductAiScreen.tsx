import { viewerTime } from "../../../design/viewer-time.js";
// Product AI keys (B7, Hybrid 1 admin area): a project's own AI provider for the calls its tests make (an AI Studio key, or a Vertex AI federation
// setup the model gateway tests before it is saved: PRODUCT-VERTEX-CLOUD-CONNECT), its eval budget per stage run, and the approved eval spend the
// model gateway holds a stage against (it counts for 15 minutes, and stops when the approver's membership changes: approve again). The key is
// write-only: it is typed once, sent, and never shown back (Cloud answers only whether one is connected).
// Only the project's admin or a company admin may change these.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { EVAL_APPROVAL_COUNTS_MINUTES, PROJECT_NAME, VERTEX_FORM, productAiPath, readProductAi, usdToMicros, type ProductAiRead } from "../../../api/admin-product-ai.js";
import { isNotConnected } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { SecretField } from "../../../design/SecretField.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { VertexGuide } from "./VertexGuide.js";
import { isVertexRefusalReason, type VertexRefusalReason } from "./vertex-guide.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, NotConnected } from "../parts.js";

const reader = { parse: readProductAi };
// Exported for the key editor (WIRING-1); the viewer's own locale and zone (VIEWER-LOCAL-TIMES).
export const when = (ms: number) => viewerTime(new Date(ms), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ProductAiScreen() {
 // L4-T3 (G3): the eval card opens this page with the project filled in (`?project=`); only a name the page would accept itself is used, anything else is ignored.
 const [params] = useSearchParams(), given = params.get("project")?.trim() ?? "", fromLink = PROJECT_NAME.test(given) ? given : undefined;
 const [typed, setTyped] = useState(fromLink ?? ""), [project, setProject] = useState<string | undefined>(fromLink);
 return <section><PageHeader focusOnMount title="Product AI keys" description="A project's own AI provider for the calls its tests make (AI Studio or Vertex AI), and what its evals may spend. Keys are write-only: Rovara uses them but never shows them." />
  <form onSubmit={event => { event.preventDefault(); if (PROJECT_NAME.test(typed.trim())) setProject(typed.trim()); }}>
   <TextField label="Project" value={typed} onChange={event => { setTyped(event.target.value); }} hint="The project's name, as on the Projects page." {...(typed !== "" && !PROJECT_NAME.test(typed.trim()) ? { error: "Lowercase letters, digits and hyphens, starting with a letter." } : {})} />
   <Button type="submit" disabled={!PROJECT_NAME.test(typed.trim())}>Open</Button>
  </form>
  {project !== undefined && <ProductAiProject key={project} project={project} />}
 </section>;
}

export function ProductAiProject({ project }: { project: string }) {
 const read = useAdminRead(`product-ai-${project}`, productAiPath(project), reader, { stable: true });
 if (read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501) return <AdminSection title="Product AI"><NotConnected what="Product AI keys" /></AdminSection>;
 return <ReadSection read={read} label={`Product AI for ${project}`}>{settings => <Settings settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>;
}

export type ProductAiNotice = { ok: boolean; text: string; reason?: VertexRefusalReason } | undefined;
export type ProductAiSend = (method: "PUT" | "DELETE", where: string, body: Record<string, unknown>, done: string) => Promise<void>;
/**
 * The one product-key change: a request id, the revision that was read, the body, and what to say on success or refusal. One press sends one change.
 * The page's Settings and G2's key rows and key editor all send through this, so the refusal words and the refresh are the same.
 */
export function useProductAiSend(project: string, revision: number, reload: () => void) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState<ProductAiNotice>();
 const send: ProductAiSend = async (method, where, body, done) => {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer(method, where, { requestId: crypto.randomUUID(), expectedRevision: revision, ...body }, { parse: answer => answer }, { retry: "never" });
   setNotice({ ok: true, text: done });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", `product-ai-${project}`] }); reload();
  } catch (error) {
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again.", ...(error instanceof ApiError && isVertexRefusalReason(error.reason) ? { reason: error.reason } : {}) });
  } finally { setBusy(false); }
 };
 return { busy, notice, setNotice, send };
}

function Settings({ settings, reload }: { settings: ProductAiRead; reload: () => void }) {
 const { busy, notice, send } = useProductAiSend(settings.project, settings.revision, reload);
 const [calls, setCalls] = useState(String(settings.evalBudget.calls)), [usd, setUsd] = useState(String(settings.evalBudget.costMicros / 1_000_000));
 const path = productAiPath(settings.project);
 const [provider, setProvider] = useState<"gemini" | "vertex">(settings.vertex.connected && !settings.key.connected ? "vertex" : "gemini");
 const budgetMicros = usdToMicros(usd);
 const callsOk = /^\d{1,6}$/u.test(calls) && Number(calls) >= 1;
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  <Select label="AI provider" value={provider} onValueChange={value => { setProvider(value === "vertex" ? "vertex" : "gemini"); }} options={[{ value: "gemini", label: "Google AI Studio (API key)" }, { value: "vertex", label: "Vertex AI (your Google Cloud project)" }]} />
  {provider === "vertex" ? <Vertex settings={settings} busy={busy} send={send} path={path} refusal={notice?.ok === false ? notice.reason : undefined} /> : <AdminSection title="AI Studio key" note={settings.key.connected ? "Connected" : "Not connected"}>
   {settings.key.connected ? <p>A key is connected{settings.key.updatedAt === undefined ? "" : `, last changed ${when(settings.key.updatedAt)}`}. It is never shown here.{settings.key.refusedAt === undefined ? "" : ` Google refused it at ${when(settings.key.refusedAt)}: replace it.`}</p>
    : <p>No key is connected. The project's tests can't call Gemini until one is.{settings.removedUntil === undefined ? "" : ` The last key was removed; it can be recovered until ${when(settings.removedUntil)}.`}</p>}
   <SecretField label={settings.key.connected ? "Replace the key" : "Paste the AI Studio key"} submitLabel={settings.key.connected ? "Replace key" : "Connect key"} onSubmit={value => send("PUT", `${path}/key`, { key: value.trim() }, settings.key.connected ? "Key replaced." : "Key connected.")} />
   {settings.key.connected && <p><Button busy={busy} onClick={() => { void send("DELETE", `${path}/key`, {}, "Key removed. Tests can't call Gemini until a key is connected again."); }}>Remove key</Button></p>}
  </AdminSection>}
  <AdminSection title="Eval budget" note="Per stage run">
   <p>Each eval stage may hold at most <b>{settings.evalBudget.calls}</b> calls and <b><Money usd={settings.evalBudget.costMicros / 1_000_000} /></b>.</p>
   <><TextField label="Calls per stage" inputMode="numeric" value={calls} onChange={event => { setCalls(event.target.value); }} {...(callsOk ? {} : { error: "A whole number, 1 or more." })} />
    <TextField label="Spend per stage (USD)" inputMode="decimal" value={usd} onChange={event => { setUsd(event.target.value); }} {...(budgetMicros !== undefined && budgetMicros > 0 ? {} : { error: "An amount in dollars, above 0." })} />
    <Button busy={busy} disabled={!callsOk || budgetMicros === undefined || budgetMicros === 0} onClick={() => { void send("PUT", `${path}/eval-budget`, { calls: Number(calls), costMicros: budgetMicros }, "Eval budget saved."); }}>Save eval budget</Button></>
  </AdminSection>
  <EvalApprovalSection settings={settings} busy={busy} send={send} />
 </>;
}

/**
 * Approved eval spend: the question selection, its inputs digest, the most calls and spend, and an optional model; Approve sends the approval, Withdraw sends null.
 * The page's Settings and G2's key editor both draw this one section, so the body, the revision and the refusal words are the same.
 */
export function EvalApprovalSection({ settings, busy, send }: { settings: ProductAiRead; busy: boolean; send: ProductAiSend }) {
 const path = productAiPath(settings.project);
 const [selection, setSelection] = useState(settings.evalApproval?.selection ?? ""), [digest, setDigest] = useState(settings.evalApproval?.inputsDigest ?? ""), [maxCalls, setMaxCalls] = useState(String(settings.evalApproval?.maxCalls ?? "")), [maxUsd, setMaxUsd] = useState(settings.evalApproval === undefined ? "" : String(settings.evalApproval.maxCostMicros / 1_000_000)), [model, setModel] = useState(settings.evalApproval?.model ?? "");
 const maxMicros = usdToMicros(maxUsd), maxCallsOk = /^\d{1,6}$/u.test(maxCalls) && Number(maxCalls) >= 1;
 return <>
  <AdminSection title="Approved eval spend" note={settings.evalApproval === undefined ? "None" : settings.evalApproval.state !== "current" ? "Approve again" : settings.evalApproval.approvedByYou ? "Approved by you" : "Approved by another admin"}>
   {settings.evalApproval === undefined ? <p>No eval spend is approved, so the final check's eval can't hold money for this project.</p>
    : <p>Approved {when(settings.evalApproval.approvedAt)}: <code><VisibleText text={settings.evalApproval.selection} /></code>, up to {settings.evalApproval.maxCalls} calls and <Money usd={settings.evalApproval.maxCostMicros / 1_000_000} />{settings.evalApproval.model === undefined ? "" : ` on ${settings.evalApproval.model}`}. An approval counts for {EVAL_APPROVAL_COUNTS_MINUTES} minutes.</p>}
   {settings.evalApproval !== undefined && settings.evalApproval.state !== "current" && <p role="status" data-testid="approve-again">{settings.evalApproval.state === "withdrawn" ? "This approval was withdrawn because the approver's membership or role changed." : `This approval is more than ${String(EVAL_APPROVAL_COUNTS_MINUTES)} minutes old.`} The eval can't hold money on it: approve it again.</p>}
   <div className="rv-eval-approval-fields"><TextField label="Question selection" value={selection} maxLength={512} onChange={event => { setSelection(event.target.value); }} />
    <TextField label="Inputs digest (SHA-256, from the eval's confirmation)" value={digest} maxLength={64} spellCheck={false} onChange={event => { setDigest(event.target.value.trim()); }} {...(digest === "" || /^[a-f0-9]{64}$/u.test(digest) ? {} : { error: "64 lowercase hex characters." })} />
    <TextField label="Most calls" inputMode="numeric" value={maxCalls} onChange={event => { setMaxCalls(event.target.value); }} />
    <TextField label="Most spend (USD)" inputMode="decimal" value={maxUsd} onChange={event => { setMaxUsd(event.target.value); }} />
    <TextField label="Model (optional)" value={model} maxLength={128} onChange={event => { setModel(event.target.value.trim()); }} />
    </div>
    <p><Button variant="primary" busy={busy} disabled={selection.trim() === "" || !/^[a-f0-9]{64}$/u.test(digest) || !maxCallsOk || maxMicros === undefined || maxMicros === 0} onClick={() => { void send("PUT", `${path}/eval-approval`, { approval: { selection: selection.trim(), inputsDigest: digest, maxCalls: Number(maxCalls), maxCostMicros: maxMicros, ...(model === "" ? {} : { model }) } }, "Eval spend approved."); }}>Approve eval spend</Button>
    {settings.evalApproval !== undefined && <> <Button busy={busy} onClick={() => { void send("PUT", `${path}/eval-approval`, { approval: null }, "Approval withdrawn."); }}>Withdraw approval</Button></>}</p>
  </AdminSection>
 </>;
}

type Send = ProductAiSend;
/** Vertex AI: the customer's workload identity pool trusts Rovara's AWS role for this company; the model gateway tests it (a token for this
 * company, and another company refused) before Cloud saves it. There is no secret to type. */
/** `removable` false: the caller draws Remove itself (G2's key rows); the connect form and its refusal guide are the same. */
export function Vertex({ settings, busy, send, path, refusal, removable = true }: { settings: ProductAiRead; busy: boolean; send: Send; path: string; refusal?: VertexRefusalReason | undefined; removable?: boolean }) {
 const v = settings.vertex;
 const [projectId, setProjectId] = useState(v.projectId ?? ""), [location, setLocation] = useState(v.location ?? "us-central1"), [audience, setAudience] = useState(""), [account, setAccount] = useState(v.serviceAccount ?? "");
 const okProject = VERTEX_FORM.projectId.test(projectId), okLocation = VERTEX_FORM.location.test(location), okAudience = VERTEX_FORM.audience.test(audience), okAccount = account === "" || VERTEX_FORM.serviceAccount.test(account);
 return <AdminSection title="Vertex AI" note={v.connected ? "Connected" : "Not connected"}>
  {v.connected ? <p>Connected to <code><VisibleText text={v.projectId ?? ""} /></code> in <code><VisibleText text={v.location ?? ""} /></code>{v.serviceAccount === undefined ? "" : <> as <code><VisibleText text={v.serviceAccount} /></code></>}{v.updatedAt === undefined ? "" : `, last changed ${when(v.updatedAt)}`}.{v.refusedAt === undefined ? "" : ` Google refused it at ${when(v.refusedAt)}: test it again.`}</p>
   : <p>Not connected. The project's tests can't call Vertex AI until it is.{settings.vertexRemovedUntil === undefined ? "" : ` The last setup was removed; it can be recovered until ${when(settings.vertexRemovedUntil)}.`}</p>}
  <VertexGuide projectId={projectId} setup={settings.vertexSetup} usesServiceAccount={account !== ""} refusal={refusal} />
  <form onSubmit={event => { event.preventDefault(); if (okProject && okLocation && okAudience && okAccount) void send("PUT", `${path}/vertex`, { projectId, location, audience, serviceAccount: account === "" ? null : account }, "Vertex AI tested and saved."); }}>
   <TextField label="Google Cloud project ID" value={projectId} spellCheck={false} onChange={event => { setProjectId(event.target.value.trim()); }} {...(projectId === "" || okProject ? {} : { error: "6 to 30 lowercase letters, digits or hyphens, starting with a letter." })} />
   <TextField label="Location" value={location} spellCheck={false} hint="A region such as us-central1, or global." onChange={event => { setLocation(event.target.value.trim()); }} {...(okLocation ? {} : { error: "A Vertex AI region, or global." })} />
   <TextField label="Workload identity provider" value={audience} spellCheck={false} hint="Its full name: //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>" onChange={event => { setAudience(event.target.value.trim()); }} {...(audience === "" || okAudience ? {} : { error: "The provider's full resource name, starting //iam.googleapis.com/projects/." })} />
   <TextField label="Service account (optional)" value={account} spellCheck={false} hint="Enter the one step 2 creates: step 2 grants the Vertex AI User role to it, so real calls need it." onChange={event => { setAccount(event.target.value.trim()); }} {...(okAccount ? {} : { error: "A Google service account address." })} />
   <Button type="submit" variant="primary" busy={busy} disabled={!okProject || !okLocation || !okAudience || !okAccount}>Test and save</Button>
  </form>
  {removable && v.connected && <p><Button busy={busy} onClick={() => { void send("DELETE", `${path}/vertex`, {}, "Vertex AI removed. Tests can't call Vertex AI until it is connected again."); }}>Remove Vertex AI</Button></p>}
 </AdminSection>;
}
