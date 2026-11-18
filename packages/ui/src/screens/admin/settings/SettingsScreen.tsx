// Company settings (Hybrid 1, DEC 223): the company's rules, the approval window, who may start work and the website ceiling, in one page with clear groups.
// Cloud's company backend serves `GET` and `PUT /v1/app/org/settings` (feat/cloud-company-backend); until a Cloud has it, the page says "not connected yet".
// Changing a rule is a sensitive change: the page shows the fresh sign-in step (Code's step-up page) first and edits only after it, and the server checks the same.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ORG_SETTINGS_PATH, WINDOW_CHOICES, capToMicros, isNotConnected, needsStepUp, readCompanySettings, windowWords, type CompanyRule, type CompanySettingsRead } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { CompanyUpkeep } from "../../setup/wiki/CompanyUpkeep.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { GatewayReadinessBanner } from "../spending/GatewayReadiness.js";
import { AdminSection, FreshSignIn, NotConnected, forgetConfirmed, useJustConfirmed } from "../parts.js";

const reader = { parse: readCompanySettings };
const RULES_MAX = 30;
type Notice = { kind: "saved" } | { kind: "proposed" } | { kind: "failed"; text: string } | { kind: "approved" } | { kind: "withdrawn" };

export function SettingsScreen() {
 const { role } = useAdminContext();
 const read = useAdminRead("company-settings", ORG_SETTINGS_PATH, reader, { stable: true });
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Company settings" /><p role="alert">Only current company owners and admins can view company settings.</p></section>;
 return <section><PageHeader focusOnMount title="Company settings" description="The company's rules, the approval window and who may start work. Project setup and model defaults have their own pages." />
  {read.isPending ? <Skeleton label="Loading company settings" />
   : read.isError && isNotConnected(read.error) ? <AdminSection title="Company rules"><NotConnected what="Company settings">The pages for projects and how we work are below.</NotConnected></AdminSection>
   : <ReadSection read={read} label="Company settings">{settings => <Settings settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>}
  <AdminSection title="Nightly upkeep for the company" note="One choice for every project"><CompanyUpkeep /></AdminSection>
  <AdminSection title="Project setup and defaults" note="Each has its own page">
   <ul className="rv-passkeys"><li><span><Link to="/app/admin/projects">Projects</Link><small>Project setup, working branches, allowed websites and archiving.</small></span></li><li><span><Link to="/app/admin/how-we-work">How we work</Link><small>Company defaults for models, locks, learning and design review.</small></span></li></ul>
  </AdminSection>
 </section>;
}

const capText = (usd: number | null | undefined) => (usd === null || usd === undefined ? "" : String(usd));
function RuleList({ rules }: { rules: readonly CompanyRule[] }) {
 if (rules.length === 0) return <p className="rv-muted">No company rules yet. Every task follows each project's own rules.</p>;
 return <ol className="rv-passkeys" aria-label="Company rules">{rules.map((rule, index) => <li key={index}><p><VisibleText text={rule.text} /></p><span className="rv-status-pill" data-tone={rule.priority === "required" ? "wait" : "idle"}>{rule.priority === "required" ? "Required" : "Preferred"}</span></li>)}</ol>;
}

function Settings({ settings, reload }: { settings: CompanySettingsRead; reload: () => void }) {
 const { developerId } = useAdminContext(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const confirmed = useJustConfirmed(developerId);
 const [editing, setEditing] = useState(false), [rules, setRules] = useState<CompanyRule[]>(() => settings.instructions.map(rule => ({ ...rule }))), [seconds, setSeconds] = useState(settings.freshSignInSeconds ?? 600), [cap, setCap] = useState(capText(settings.monthlyCapUsd));
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice>(), [stale, setStale] = useState(false), [seenVersion, setSeenVersion] = useState(settings.version);
 // The rules on screen are a copy of what was read. When the settings move on (another admin's change was approved, or this one saved), the copy is taken again,
 // so a save never sends old rules with the new version.
 const reseed = () => { setRules(settings.instructions.map(rule => ({ ...rule }))); setSeconds(settings.freshSignInSeconds ?? 600); setCap(capText(settings.monthlyCapUsd)); };
 if (seenVersion !== settings.version) { setSeenVersion(settings.version); reseed(); }
 async function after(next: Notice) { setNotice(next); setEditing(false); await query.invalidateQueries({ queryKey: ["admin", "lane-c", "company-settings"] }); reload(); }
 async function save() {
  setBusy(true); setNotice(undefined);
  try {
   const micros = capToMicros(cap);
   if (micros === undefined) { setNotice({ kind: "failed", text: "The monthly cap must be an amount in dollars, like 1500 or 1500.50." }); return; }
   const saved = typeof settings.raw["budgets"] === "object" && settings.raw["budgets"] !== null ? settings.raw["budgets"] as Record<string, unknown> : {};
   // The learning cap is never above the company cap (Cloud refuses it): lowering the company cap lowers it too.
   const learning = saved["learningMonthlyUsdMicros"];
   const budgets = { ...saved, companyMonthlyUsdMicros: micros, ...(typeof learning === "number" && micros !== null ? { learningMonthlyUsdMicros: Math.min(learning, micros) } : {}) };
   const settingsBody = { ...settings.raw, budgets, instructions: rules.filter(rule => rule.text.trim() !== "").map(rule => ({ text: rule.text.trim(), priority: rule.priority })), freshSignInSeconds: seconds };
   const answer = await api.sendAnswer("PUT", ORG_SETTINGS_PATH, { expectedVersion: settings.version, settings: settingsBody }, { parse: body => body }, { retry: "never" });
   const proposed = typeof answer === "object" && answer !== null && "pending" in answer && !("settings" in answer);
   await after(proposed ? { kind: "proposed" } : { kind: "saved" });
  } catch (error) {
   if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); setNotice(undefined); }
   else setNotice({ kind: "failed", text: error instanceof ApiError ? error.message : "Couldn't save the settings. Try again." });
  } finally { setBusy(false); }
 }
 async function decide(change: string, action: "approve" | "withdraw") {
  setBusy(true); setNotice(undefined);
  try { await api.sendAnswer("POST", `${ORG_SETTINGS_PATH}/pending/${encodeURIComponent(change)}/${action}`, {}, { parse: body => body }, { retry: "never" }); await after({ kind: action === "approve" ? "approved" : "withdrawn" }); }
  catch (error) { if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); } else setNotice({ kind: "failed", text: error instanceof ApiError ? error.message : "Couldn't finish that. Try again." }); }
  finally { setBusy(false); }
 }
 const pending = settings.pending, mine = pending?.proposedBy === developerId;
 const ready = confirmed && !stale;
 return <>
  <GatewayReadinessBanner readiness={settings.modelGateway} />
  {notice?.kind === "saved" && <p role="status">Saved. The new rules apply to the next task that starts.</p>}
  {notice?.kind === "proposed" && <p role="status">Sent for approval. Another company admin must approve this change before it applies.</p>}
  {notice?.kind === "approved" && <p role="status">Approved. The new rules apply to the next task that starts.</p>}
  {notice?.kind === "withdrawn" && <p role="status">Withdrawn. Nothing changed.</p>}
  {notice?.kind === "failed" && <p role="alert" data-testid="settings-error"><VisibleText text={notice.text} /></p>}
  {pending !== undefined && <AdminSection title="Waiting for approval" note={mine ? "You proposed this" : "Proposed by another admin"}>
   <p>A change to the company's rules is waiting for a second admin{pending.expiresAt !== "" ? `, until ${new Date(pending.expiresAt).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })}` : ""}.</p>
   <RuleList rules={pending.instructions} />
   {pending.freshSignInSeconds !== undefined && <p className="rv-muted">Approval window would become {windowWords(pending.freshSignInSeconds)}.</p>}
   {!mine && (ready ? <Button variant="primary" busy={busy} onClick={() => { void decide(pending.changeId, "approve"); }}>Approve this change</Button> : <FreshSignIn action="approve this change" refused={stale} />)}
   <p><Button busy={busy} onClick={() => { void decide(pending.changeId, "withdraw"); }}>{mine ? "Withdraw my change" : "Reject this change"}</Button></p>
  </AdminSection>}
  <AdminSection title="Company rules" note="Every task follows these" actions={!editing && pending === undefined ? <Button onClick={() => { reseed(); setEditing(true); }}>Change rules</Button> : undefined}>
   {!editing ? <RuleList rules={settings.instructions} /> : !ready ? <FreshSignIn action="change the company's rules" refused={stale} /> : <>
    <FreshSignIn action="change the company's rules" done />
    <div role="group" aria-label="Edit company rules">{rules.map((rule, index) => <div key={index} className="rv-rule-edit"><TextField label={`Rule ${index + 1}`} value={rule.text} maxLength={600} onChange={event => { setRules(rules.map((entry, at) => (at === index ? { ...entry, text: event.target.value } : entry))); }} /><Select label="How firm" value={rule.priority} options={[{ value: "required", label: "Required" }, { value: "preferred", label: "Preferred" }]} onValueChange={value => { setRules(rules.map((entry, at) => (at === index ? { ...entry, priority: value === "preferred" ? "preferred" : "required" } : entry))); }} /><Button onClick={() => { setRules(rules.filter((_, at) => at !== index)); }}>Remove rule {index + 1}</Button></div>)}</div>
    <p><Button disabled={rules.length >= RULES_MAX} onClick={() => { setRules([...rules, { text: "", priority: "required" }]); }}>Add a rule</Button></p>
    <TextField label="Company monthly cap (USD)" id="monthly-cap-field" inputMode="decimal" value={cap} onChange={event => { setCap(event.target.value); }} hint={capToMicros(cap) === 0 ? "A $0 cap blocks all model gateway use." : "Leave empty for no cap. The model gateway serves a company only when it has one."} {...(capToMicros(cap) === undefined ? { error: "Enter an amount in dollars, like 1500 or 1500.50." } : {})} />
    <Select label="Approval window" value={String(seconds)} options={WINDOW_CHOICES.map(choice => ({ value: String(choice.seconds), label: choice.label }))} onValueChange={value => { setSeconds(Number(value)); }} />
    <p className="rv-muted">Making a rule looser needs a second admin to approve it.</p>
    <p><Button variant="primary" busy={busy} disabled={capToMicros(cap) === undefined} onClick={() => { void save(); }}>Save rules</Button> <Button onClick={() => { setEditing(false); reseed(); }}>Cancel</Button></p>
   </>}
  </AdminSection>
  <AdminSection id="monthly-cap" title="Monthly cap" note="What the model gateway holds you to">
   {settings.monthlyCapUsd === undefined ? <NotConnected what="The monthly cap" /> : settings.monthlyCapUsd === null ? <p>No monthly cap is set. Rovara picks no amount for you. Use <b>Change rules</b> above to set one.</p> : <p>The company's monthly cap is <b><Money usd={settings.monthlyCapUsd} /></b>.{settings.monthlyCapUsd === 0 ? " A $0 cap blocks all model gateway use." : ""}</p>}
  </AdminSection>
  <AdminSection title="Approval window" note="For sensitive changes">
   <p>Admins confirm it's them again before they change rules, send an admin invite or remove a passkey. The confirmation counts for <b>{windowWords(settings.freshSignInSeconds)}</b>.</p>
  </AdminSection>
  <AdminSection title="Who may start work">
   {settings.start === undefined ? <NotConnected what="The start rule" /> : <dl className="rv-kv-list"><div className="rv-kv"><dt>New tasks</dt><dd>{settings.start.allow ? "Anyone with project access may start one" : "Paused: nobody may start a task"}</dd></div><div className="rv-kv"><dt>Largest estimate without asking</dt><dd>{settings.start.maxEstimateUsd === undefined ? "No limit" : <Money usd={settings.start.maxEstimateUsd} />}</dd></div></dl>}
  </AdminSection>
  <AdminSection title="Websites a project may allow">
   {settings.websites === undefined ? <NotConnected what="The website ceiling" /> : settings.websites.mode === "any" ? <p>Any website. Each project sets its own list.</p> : <><p>Only these sites:</p><ul className="rv-passkeys">{settings.websites.hosts.map(host => <li key={host}><code><VisibleText text={host} /></code></li>)}</ul></>}
  </AdminSection>
 </>;
}
