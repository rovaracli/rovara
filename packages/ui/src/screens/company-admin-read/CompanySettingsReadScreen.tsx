import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ORG_SETTINGS_PATH, type CompanyRule } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { HeldState } from "../../design/HeldState.js";
import { Money } from "../../design/Money.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Select } from "../../design/Select.js";
import { StatusChip } from "../../design/StatusChip.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { CompanyUpkeep } from "../setup/wiki/CompanyUpkeep.js";
import { KnowledgeStays } from "../admin/settings/KnowledgeStays.js";
import { OutboundAddresses } from "../admin/settings/OutboundAddresses.js";
import { GatewayReadinessBanner } from "../admin/spending/GatewayReadiness.js";
import { useCompanyReadScope } from "./ReadEntry.js";
import { ReadState, readIsStale } from "./ReadState.js";
import { Chevron, Fact, Facts, ReadSection, Rows, Stamp } from "./parts.js";
import { companyReadKey, settingsReader, useCompanyRead, type ReadScope } from "./read-model.js";
import { ALLOWED_LIST_NAME } from "../admin/projects/allowed-list-name.js";
import { POLICY_NOT_ENFORCED } from "./company-policy-words.js";

type Rule = { text: string; priority: "required" | "preferred" };
type Settings = ReturnType<ReturnType<typeof settingsReader>["parse"]>;
type Notice = { kind: "saved" } | { kind: "proposed" } | { kind: "checking" } | { kind: "failed"; text: string } | { kind: "approved" } | { kind: "withdrawn" };
const RULES_MAX = 30;

type RuleChange = "added" | "removed" | "firmness";
const CHANGE_WORDS: Record<RuleChange, string> = { added: "Added", removed: "Removed", firmness: "How firm changes" };
/** A rule's change against the other list, by its text: only in this list = added / removed, same text with another firmness = firmness. Unchanged rules carry no mark. */
function changeOf(rule: Rule, other: readonly Rule[], onlyHere: "added" | "removed"): RuleChange | undefined {
 const match = other.find(candidate => candidate.text === rule.text);
 return match === undefined ? onlyHere : match.priority === rule.priority ? undefined : "firmness";
}
function RuleList({ rules, compareTo, onlyHere }: { rules: readonly Rule[]; compareTo?: readonly Rule[]; onlyHere?: "added" | "removed" }) {
 return <ul className="rv-car-rules">{rules.map((rule, i) => {
  const change = compareTo === undefined || onlyHere === undefined ? undefined : changeOf(rule, compareTo, onlyHere);
  return <li key={i} {...(change === undefined ? {} : { "data-change": change })}><strong><VisibleText text={rule.text} /></strong><span>{rule.priority === "required" ? "Required" : "Preferred"}</span>{change !== undefined && <span className="rv-car-rule-change">{CHANGE_WORDS[change]}</span>}</li>;
 })}</ul>;
}
// One home each: every row opens the live page that edits it.
const edited: readonly (readonly [string, string, string])[] = [
 ["Money", "Limits, who pays, the report", "/app/admin/money/budgets"],
 ["People", "People, roles, invites", "/app/admin/people"],
 ["Connections", "GitHub, Slack, Linear, AI provider", "/app/admin/connections"],
 ["Projects", "Project setup, working branches, allowed addresses and archiving", "/app/admin/projects"],
 ["How we work", "Company defaults for models, locks, learning and design review", "/app/admin/how-we-work"],
];

/**
 * The live company settings actions (moved here unchanged from the retired admin/settings/SettingsScreen): Save rules (PUT /v1/app/org/settings with the read's
 * version and the whole document), Approve / Reject / Withdraw a pending change (POST .../pending/<id>/approve|withdraw). The server decides authority and refuses
 * with its own words. The state lives on the page, above the read, so a notice survives the re-read that follows a change. G1 SHIP adds one client fence:
 * nothing is sent while the admin area is re-checking who this is, or while another send is in flight.
 */
function useSettingsActions(scope: ReadScope, reload: () => void, written: (proposed: boolean) => void, freshen: () => Promise<Settings | undefined>) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice>(), sending = useRef(false);
 const blocked = () => sending.current || scope.checking;
 // The SEND-TIME fresh check. The page keeps the last good facts on screen while a read is fetched again, so an action can be pressed on facts that a read in flight is about to replace.
 // The press waits for that read: nothing is sent unless it answered, no identity re-check began meanwhile, and what the action is bound to (the version a Save was edited against, the change an
 // Approve / Reject names) is unchanged in the fresh read. Otherwise ZERO sends and one sentence says so.
 const checkingNow = useRef(scope.checking);
 useEffect(() => { checkingNow.current = scope.checking; });
 async function fresh(same: (now: Settings) => boolean): Promise<boolean> {
  const now = await freshen();
  if (now === undefined) { setNotice({ kind: "failed", text: "Rovara couldn't confirm the current settings, so nothing was sent." }); return false; }
  // The press is dropped, never sent: the admin area began re-checking who this is while the read was awaited. Say so instead of doing nothing.
  if (checkingNow.current) { setNotice({ kind: "checking" }); return false; }
  if (!same(now)) { setNotice({ kind: "failed", text: "These settings changed while they were being read again, so nothing was sent. Check the new details and try again." }); return false; }
  return true;
 }
 async function after(next: Notice, done: () => void) { written(next.kind === "proposed"); setNotice(next); done(); await query.invalidateQueries({ queryKey: ["admin", "lane-c", "company-settings"] }); reload(); }
 async function save(settings: Settings, rules: readonly CompanyRule[], done: () => void) {
  if (blocked()) return;
  sending.current = true; setBusy(true); setNotice(undefined);
  try {
   if (!(await fresh(now => now.version === settings.version && now.pending?.changeId === settings.pending?.changeId))) return;
   const settingsBody = { ...settings.raw, instructions: rules.filter(rule => rule.text.trim() !== "").map(rule => ({ text: rule.text.trim(), priority: rule.priority })) };
   const answer = await api.sendAnswer("PUT", ORG_SETTINGS_PATH, { expectedVersion: settings.version, settings: settingsBody }, { parse: body => body }, { retry: "never" });
   const proposed = typeof answer === "object" && answer !== null && "pending" in answer && !("settings" in answer);
   await after(proposed ? { kind: "proposed" } : { kind: "saved" }, done);
  } catch (error) {
   setNotice({ kind: "failed", text: error instanceof ApiError ? error.message : "Couldn't save the settings. Try again." });
  } finally { sending.current = false; setBusy(false); }
 }
 async function decide(change: string, action: "approve" | "withdraw") {
  if (blocked()) return;
  sending.current = true; setBusy(true); setNotice(undefined);
  try {
   if (!(await fresh(now => now.pending?.changeId === change))) return;
   await api.sendAnswer("POST", `${ORG_SETTINGS_PATH}/pending/${encodeURIComponent(change)}/${action}`, {}, { parse: body => body }, { retry: "never" }); await after({ kind: action === "approve" ? "approved" : "withdrawn" }, () => undefined);
  } catch (error) { setNotice({ kind: "failed", text: error instanceof ApiError ? error.message : "Couldn't finish that. Try again." }); }
  finally { sending.current = false; setBusy(false); }
 }
 return { busy, notice, save, decide, checking: scope.checking };
}
type Actions = ReturnType<typeof useSettingsActions>;

function NoticeLine({ notice, reload }: { notice: Notice | undefined; reload: () => void }) {
 if (notice === undefined) return null;
 if (notice.kind === "failed") return <div className="rv-car-notice rv-car-notice-bad" role="alert" data-testid="settings-error"><p><VisibleText text={notice.text} /></p><div className="rv-car-actions"><Button onClick={reload}>Reload settings</Button></div></div>;
 if (notice.kind === "checking") return <p className="rv-car-notice" role="status" data-testid="settings-checking">Rovara is checking your access; nothing was sent. Try again in a moment.</p>;
 if (notice.kind === "proposed") return <p className="rv-car-notice" role="status"><span>Your change was sent for approval.</span> <span>Another company admin must approve this change before it applies.</span></p>;
 const text = notice.kind === "saved" ? "Saved. The new rules apply to the next task that starts."
  : notice.kind === "approved" ? "Approved. The new rules apply to the next task that starts." : "Withdrawn. The current rules stay in force.";
 return <p className="rv-car-notice" role="status">{text}</p>;
}

/** Change rules: the live editor. Offered only when the rules were read (an unread list would be saved as empty) and no change is waiting. */
function RulesEditor({ settings, actions, offered, readOnly }: { settings: Settings; actions: Actions; offered: boolean; /** The rules as read; drawn only while the editor is closed, so the same rules are never shown twice. */ readOnly: ReactNode }) {
 const [editing, setEditing] = useState(false), [rules, setRules] = useState<CompanyRule[]>(() => settings.instructions.map(rule => ({ ...rule })));
 // `base` is the settings the draft was seeded from: a Save is bound to ITS version (never the newer one), so old rules are never sent with a new version.
 const [base, setBase] = useState(settings);
 const reseed = () => { setBase(settings); setRules(settings.instructions.map(rule => ({ ...rule }))); };
 // Not editing: the copy is taken again when the settings move on. Editing: the draft is KEPT (never replaced silently) and the page says the rules moved on.
 if (!editing && base.version !== settings.version) reseed();
 const movedOn = editing && base.version !== settings.version;
 if (!editing) return <>{readOnly}{offered && <div className="rv-car-actions"><Button disabled={actions.checking} onClick={() => { reseed(); setEditing(true); }}>Change rules</Button></div>}</>;
 return <div className="rv-car-editor"><h3>Company rules</h3>
  {movedOn && <div className="rv-car-notice" role="status" data-testid="rules-changed-elsewhere"><p>These rules were changed elsewhere. Review the latest before saving.</p>{settings.instructionsKnown && (settings.instructions.length === 0 ? <p>No company rules are in force now.</p> : <RuleList rules={settings.instructions} />)}</div>}
  <div role="group" aria-label="Edit company rules">{rules.map((rule, index) => <div key={index} className="rv-rule-edit"><TextArea label={`Rule ${index + 1}`} value={rule.text} rows={2} maxLength={600} onChange={event => { const text = event.target.value.replace(/\s*\n\s*/g, " "); setRules(rules.map((entry, at) => (at === index ? { ...entry, text } : entry))); }} /><Select label="How firm" value={rule.priority} options={[{ value: "required", label: "Required" }, { value: "preferred", label: "Preferred" }]} onValueChange={value => { setRules(rules.map((entry, at) => (at === index ? { ...entry, priority: value === "preferred" ? "preferred" : "required" } : entry))); }} /><Button onClick={() => { setRules(rules.filter((_, at) => at !== index)); }}>Remove rule {index + 1}</Button></div>)}</div>
  <div className="rv-car-actions"><Button disabled={rules.length >= RULES_MAX} onClick={() => { setRules([...rules, { text: "", priority: "required" }]); }}>Add a rule</Button></div>
  <p className="rv-car-note">Making a rule looser needs a second admin to approve it.</p>
  <div className="rv-car-actions"><Button variant="primary" busy={actions.busy} disabled={actions.checking} onClick={() => { void actions.save(base, rules, () => setEditing(false)); }}>Save rules</Button><Button onClick={() => { setEditing(false); reseed(); }}>Cancel</Button></div>
 </div>;
}

export function CompanySettingsReadScreen() {
 const scope = useCompanyReadScope(), read = useCompanyRead(scope, "settings", ORG_SETTINGS_PATH, settingsReader(scope.orgId)), cache = useQueryClient();
 // The kept facts of a failed re-read are display only: while they are stale (DEC 254zzz324) every action stays disabled, like while the admin area re-checks who this is.
 const stale = readIsStale(read), key = companyReadKey(scope, "settings", ORG_SETTINGS_PATH);
 const readCount = () => cache.getQueryState(key)?.dataUpdateCount ?? 0;
 // A change was saved and no read has answered since: the facts on hand predate it, so the page draws none and never says "Nothing was changed".
 const [wroteAt, setWroteAt] = useState<number>(), [proposedWrite, setProposedWrite] = useState(false);
 const afterWrite = wroteAt !== undefined && readCount() <= wroteAt;
 // The facts stay on screen while the read is fetched again; an action pressed then re-checks the fresh read at send time (useSettingsActions).
 const freshen = async (): Promise<Settings | undefined> => {
  if (cache.getQueryState(key)?.fetchStatus === "fetching") { const result = await read.refetch({ cancelRefetch: false }); return result.isError ? undefined : result.data; }
  const state = cache.getQueryState<Settings>(key);
  return state?.status === "success" ? state.data : undefined;
 };
 const actions = useSettingsActions({ ...scope, checking: scope.checking || stale }, () => { void read.refetch(); }, proposed => { setWroteAt(readCount()); setProposedWrite(proposed); }, freshen);
 return <ReadState read={read} label="Company settings" code="COMPANY-SETTINGS-READ-FAILED" afterWrite={afterWrite} {...(proposedWrite ? { changeSaid: "Your change was sent for approval." } : {})}
  header={(data, readAt) => {
   const waiting = data?.pending !== undefined;
   const meta = data === undefined ? undefined : [scope.company, waiting ? "1 change waiting for approval" : undefined, readAt === undefined ? undefined : `Read\u00a0from\u00a0Rovara\u00a0${readAt}`].filter(Boolean).join(" · ");
   return <PageHeader focusOnMount title="Company settings" breadcrumbs={[{ label: "Company", href: "/app/admin" }, { label: "Settings" }]} {...(meta === undefined ? {} : { meta })} />;
  }}
  before={<NoticeLine notice={actions.notice} reload={() => { void read.refetch(); }} />}
  after={<>
   <section className="rv-car-card" aria-labelledby="company-settings-upkeep"><h2 id="company-settings-upkeep">Nightly upkeep for the company</h2><p className="rv-car-lede">One choice for every project.</p><CompanyUpkeep /></section>
   <KnowledgeStays />
   <OutboundAddresses />
   <ReadSection title="Edited elsewhere, one home each">
    <Rows>{edited.map(([where, what, to]) => <li key={where}><Link to={to} aria-label={where}><p><span aria-hidden="true" className="rv-car-dash">&ndash;</span>{what}</p><span className="rv-car-row-side"><span className="rv-car-row-label">{where}</span><Chevron /></span></Link></li>)}</Rows>
   </ReadSection>
  </>}>{settings => {
  const rules: ReactNode = !settings.instructionsKnown ? <p>Rovara can&apos;t tell yet which company rules apply.</p> : settings.instructions.length === 0 ? <p>No company rules yet. Every task follows each project&apos;s own rules.</p> : <RuleList rules={settings.instructions} />;
  const pending = settings.pending, mine = pending?.proposedBy === scope.personId;
  const limit = settings.monthlyCapUsd;
  return <>
   <GatewayReadinessBanner readiness={settings.modelGateway} />
   {!settings.pendingKnown ? <ReadSection title="Pending change"><p className="rv-car-quiet-card">Rovara can&apos;t tell yet what change is pending.</p></ReadSection>
    : pending === undefined ? null
    : <section className={mine ? "rv-car-card rv-car-pending" : "rv-car-card rv-car-pending rv-car-pending-you"} id="pending-change" aria-labelledby="rv-car-pending-title">
     <header><div className="rv-car-pending-head">{mine ? <StatusChip state="waiting_for" waitingFor="approval" /> : <StatusChip state="needs_you" />}<h2 id="rv-car-pending-title">A change is waiting for approval</h2></div>{pending.proposedAt !== "" && <span className="rv-car-pending-when">Proposed <Stamp iso={pending.proposedAt} />{pending.expiresAt !== "" && <> · open until <Stamp iso={pending.expiresAt} /></>}</span>}</header>
     <p>{mine ? "You proposed this change." : "A change to the company rules is waiting for a different owner or admin."} Nothing has changed yet: the current rules stay in force until it is approved.</p>
     <div className="rv-car-compare">
      <div><h3>Now, and still in force</h3>{!settings.instructionsKnown || settings.instructions.length === 0 ? rules : <RuleList rules={settings.instructions} compareTo={pending.instructions} onlyHere="removed" />}</div>
      <div><h3>If approved</h3>{pending.instructions.length === 0 ? <p>No rules were returned in the pending change.</p> : <RuleList rules={pending.instructions} {...(settings.instructionsKnown ? { compareTo: settings.instructions, onlyHere: "added" as const } : {})} />}</div>
     </div>
     <Facts><Fact label="Proposed by">{mine ? "You" : "Another admin"}</Fact></Facts>
     <div className="rv-car-actions">
      {!mine && <Button variant="primary" busy={actions.busy} disabled={actions.checking} onClick={() => { void actions.decide(pending.changeId, "approve"); }}>Approve this change</Button>}
      <Button busy={actions.busy} disabled={actions.checking} onClick={() => { void actions.decide(pending.changeId, "withdraw"); }}>{mine ? "Withdraw my change" : "Reject this change"}</Button>
     </div>
    </section>}
   <section className="rv-car-card" aria-labelledby="company-settings-policy"><h2 id="company-settings-policy">Company policy</h2>
    <p className="rv-car-note" data-testid="company-policy-not-enforced">{POLICY_NOT_ENFORCED}</p>
    <Facts>
     <Fact label="Who may start work">{settings.start === undefined ? <HeldState /> : settings.start.allow ? "Starting tasks is on for the company. Project access, estimates and other checks still apply." : "New tasks are paused."}</Fact>
     {settings.start !== undefined && <Fact label="Largest estimate without asking">{settings.start.maxEstimateUsd === undefined ? "No limit" : <Money usd={settings.start.maxEstimateUsd} />}</Fact>}
     <Fact label={ALLOWED_LIST_NAME}>{settings.websites === undefined ? <HeldState /> : settings.websites.mode === "any" ? "Any address. Each project sets its own list." : <ul className="rv-car-hosts">{settings.websites.hosts.map(host => <li key={host}><code><VisibleText text={host} /></code></li>)}</ul>}</Fact>
    </Facts>
    <RulesEditor key={`${scope.orgId}:${scope.personId}`} settings={settings} actions={actions} offered={pending === undefined && settings.pendingKnown && settings.instructionsKnown} readOnly={pending === undefined || !settings.pendingKnown ? <><h3>Company rules</h3><p className="rv-car-lede">Every task follows these.</p>{rules}</> : null} />
   </section>
   <section className="rv-car-card" id="monthly-cap" aria-label="Monthly limit"><h2>Monthly limit</h2>
    {limit === undefined ? <p><HeldState /></p> : limit === null ? <p>No monthly limit is set.</p> : <p>The company&apos;s monthly limit is <b><Money usd={limit} /></b>. It applies to all AI use.</p>}
    <p className="rv-car-lede">Change the monthly limit in <Link to="/app/admin/ai-spending">AI and spending</Link>.</p>
   </section>
   <section className="rv-car-card" aria-labelledby="company-settings-summary"><h2 id="company-settings-summary">Company</h2><p className="rv-car-lede">Shown in the nav, in invites and in Slack messages.</p>
    <Facts>
     <Fact label="Company name"><VisibleText text={scope.company} /></Fact>
     <Fact label="Your role">{scope.role === "owner" ? "Owner" : "Admin"}</Fact>
    </Facts>
   </section>
  </>;
 }}</ReadState>;
}
