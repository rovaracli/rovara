// UX1 (platform UX slice 1, "First day"): AI providers on one screen. It says plainly which providers this install lets a company add and why the others are
// held; for the ones that are allowed, an owner or admin adds a provider with plain fields (the key is write-only: sent once, cleared from the form, never shown
// back), presses "Check it works" (a tick, or exactly what the provider said), and removes it after reviewing. The customer's own key pays for its use.
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
type Kind = "anthropic" | "openai" | "openrouter" | "bedrock" | "endpoint";
export const PROVIDER_NAMES: Readonly<Record<Kind, string>> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", bedrock: "Amazon Bedrock (your AWS account)", endpoint: "Your own model gateway" };
/** Why a provider can't be added yet, when the server's `available` list leaves it out. The launch list is empty on purpose (owner decision; docs/learnings/model-sources-spike.md). */
export const PROVIDERS_HELD = "Rovara turns each provider on only after it has been tested end to end with real keys. Until then, work runs on Rovara's own models and nothing needs setting up.";
interface Source { sourceId: string; kind: Kind; label: string }
const Answer = z.object({ ok: z.boolean(), message: z.string().max(2000).optional() });
const Created = z.object({ sourceId: z.string().regex(/^src_[0-9a-z]{20}$/) }).passthrough();
const Anything = { parse: (value: unknown) => value };
type Check = { state: "busy" } | { state: "ok" } | { state: "failed"; message: string };
export function ProviderSetup({ available, sources, revision, canEdit, onChanged, onChecked }: { available: readonly Kind[] | undefined; sources: readonly Source[]; revision: number | undefined; canEdit: boolean; onChanged: () => void; onChecked?: (sourceId: string, ok: boolean) => void }) {
 const host = useAppHost(), api = createApiClient(host);
 const addable = (available ?? []).filter((kind): kind is Exclude<Kind, "endpoint"> => kind !== "endpoint");
 const [checks, setChecks] = useState<Record<string, Check>>({}), [removing, setRemoving] = useState<Source>(), [removeError, setRemoveError] = useState<string>(), [busy, setBusy] = useState(false);
 async function check(sourceId: string) {
  setChecks(current => ({ ...current, [sourceId]: { state: "busy" } }));
  try {
   const result = await api.send("POST", `/v1/app/org/model-sources/${sourceId}/check`, undefined, Answer, { retry: "never" });
   const value = result.kind === "done" ? result.value : undefined;
   setChecks(current => ({ ...current, [sourceId]: value?.ok === true ? { state: "ok" } : { state: "failed", message: value?.message ?? "The check didn't finish. Try again." } }));onChecked?.(sourceId, value?.ok === true);
  } catch (failure) { setChecks(current => ({ ...current, [sourceId]: { state: "failed", message: failure instanceof ApiError ? failure.message : "The check didn't finish. Try again." } }));onChecked?.(sourceId, false); }
 }
 async function remove() {
  if (removing === undefined || revision === undefined) return;setBusy(true);setRemoveError(undefined);
  try { await api.send("DELETE", `/v1/app/org/model-sources/${removing.sourceId}`, { requestId: crypto.randomUUID(), expectedRevision: revision }, Anything, { retry: "never" });setRemoving(undefined);onChanged(); }
  catch (failure) { setRemoveError(failure instanceof ApiError ? failure.message : "Couldn't remove it. Refresh and try again."); } finally { setBusy(false); }
 }
 return <section aria-labelledby="ai-providers"><h2 id="ai-providers">AI providers</h2>
  {available === undefined ? <p>This Rovara install doesn't say which providers can be added. Work runs on Rovara's own models.</p>
   : addable.length === 0 ? <><p>No provider can be added on this Rovara install yet.</p><p>{PROVIDERS_HELD}</p></>
   : <p>You can add {addable.map(kind => PROVIDER_NAMES[kind]).join(", ")} here. {(["anthropic", "openai", "openrouter", "bedrock"] as const).filter(kind => !addable.includes(kind)).length > 0 ? `${(["anthropic", "openai", "openrouter", "bedrock"] as const).filter(kind => !addable.includes(kind)).map(kind => PROVIDER_NAMES[kind]).join(", ")}: not available yet. ${PROVIDERS_HELD}` : ""} Your company's own key pays for work that uses it.</p>}
  {sources.length > 0 && <ul className="rv-provider-list">{sources.map(source => { const result = checks[source.sourceId];return <li key={source.sourceId}><p><strong><VisibleText text={source.label} /></strong> · {PROVIDER_NAMES[source.kind]}</p>
   {canEdit && <><Button busy={result?.state === "busy"} onClick={() => { void check(source.sourceId); }}>Check it works</Button><Button variant="quiet" onClick={() => { setRemoveError(undefined);setRemoving(source); }}>Remove</Button></>}
   {result?.state === "ok" && <p role="status">✓ It works. Rovara reached {PROVIDER_NAMES[source.kind]} and the models answered.</p>}
   {result?.state === "failed" && <p role="alert">It didn't work: <VisibleText text={result.message} /></p>}</li>; })}</ul>}
  {canEdit && addable.length > 0 && <AddProvider kinds={addable} onAdded={sourceId => { onChanged();void check(sourceId); }} />}
  {!canEdit && addable.length > 0 && <p className="rv-muted">Only a company owner or admin can add or remove providers.</p>}
  <Dialog title="Remove this provider?" description="New work stops using it at once. Its key is deleted." open={removing !== undefined} onOpenChange={open => { if (!open) setRemoving(undefined); }}>
   {removing !== undefined && <p>Remove <VisibleText text={removing.label} /> ({PROVIDER_NAMES[removing.kind]})?</p>}
   <Button variant="danger" busy={busy} disabled={revision === undefined} onClick={() => { void remove(); }}>Remove provider</Button>{removeError && <p role="alert"><VisibleText text={removeError} /></p>}
  </Dialog></section>;
}
function AddProvider({ kinds, onAdded }: { kinds: ReadonlyArray<Exclude<Kind, "endpoint">>; onAdded: (sourceId: string) => void }) {
 const host = useAppHost();
 const [kind, setKind] = useState<Exclude<Kind, "endpoint">>(kinds[0]!), [label, setLabel] = useState(""), [model, setModel] = useState(""), [key, setKey] = useState(""), [roleArn, setRoleArn] = useState(""), [region, setRegion] = useState("");
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
 const bedrock = kind === "bedrock", ready = label.trim() !== "" && model.trim() !== "" && (bedrock ? roleArn.trim() !== "" && region.trim() !== "" : key !== "");
 async function add() {
  if (!ready || busy) return;setBusy(true);setError(undefined);
  const source = { kind, label: label.trim(), models: [{ catalog: { provider: kind === "bedrock" ? "amazon-bedrock" : kind, modelId: model.trim() } }], ...(bedrock ? { roleArn: roleArn.trim(), region: region.trim() } : {}) };
  try {
   const result = await createApiClient(host).send("POST", "/v1/app/org/model-sources", { requestId, source, ...(bedrock ? {} : { apiKey: key }) }, Created, { retry: "never" });
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara couldn't confirm the provider was added. Refresh before trying again.");
   setLabel("");setModel("");setRoleArn("");setRegion("");setRequestId(crypto.randomUUID());onAdded(result.value.sourceId);
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't add the provider. Try again."); }
  finally { setKey("");setBusy(false); }
 }
 const changed = (set: (value: string) => void) => (event: { target: { value: string } }) => { set(event.target.value);setRequestId(crypto.randomUUID()); };
 return <form className="rv-provider-add" onSubmit={event => { event.preventDefault();void add(); }}><h3>Add a provider</h3>
  <Select label="Provider" value={kind} onValueChange={value => { setKind(value as Exclude<Kind, "endpoint">);setRequestId(crypto.randomUUID()); }} options={kinds.map(value => ({ value, label: PROVIDER_NAMES[value] }))} />
  <TextField label="Name" hint="What your team sees, for example Acme Anthropic." value={label} maxLength={64} onChange={changed(setLabel)} />
  <TextField label="Model ID" hint="The model's ID at the provider." value={model} maxLength={200} autoComplete="off" spellCheck={false} onChange={changed(setModel)} />
  {bedrock ? <><TextField label="Role ARN" hint="An IAM role in your AWS account that Rovara may assume. After adding, the page shows the trust policy to give it." value={roleArn} autoComplete="off" spellCheck={false} onChange={changed(setRoleArn)} /><TextField label="AWS Region" hint="For example us-east-1." value={region} autoComplete="off" spellCheck={false} onChange={changed(setRegion)} /></>
   : <TextField label="API key" type="password" hint="Sent once to be stored securely. Rovara never shows it again." value={key} autoComplete="new-password" spellCheck={false} onChange={event => { setKey(event.target.value); }} />}
  <Button type="submit" variant="primary" busy={busy} disabled={!ready}>Add and check it works</Button>{error && <p role="alert"><VisibleText text={error} /></p>}</form>;
}
