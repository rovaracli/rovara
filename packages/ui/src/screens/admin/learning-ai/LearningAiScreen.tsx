import { viewerTime } from "../../../design/viewer-time.js";
// Learning AI key (PRODUCT-LEARNING-CONNECT-ROUTE, DEC 226): the company's own AI provider account that lessons' learning calls run on, the
// company's monthly learning cap, and why lessons are or may be paused. Company admins only. The key is write-only: typed once, sent, never shown
// back. Company admins only, which the server checks too. It is never a project's key and is never used for a project's tests.
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LEARNING_AI_PATH, LEARNING_PROVIDER_LABELS, keyWhitespaceHint, readLearningAi, wrongProviderKeyHint, type LearningAiRead, type LearningProvider } from "../../../api/admin-learning-ai.js";
import { isNotConnected } from "../../../api/admin-company.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { SecretField } from "../../../design/SecretField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, NotConnected } from "../parts.js";
import { useAdminContext } from "../AdminLayout.js";
import { useConnectionChange } from "../ai-spending/connection-change.js";
import { HeldConnection } from "../ai-spending/HeldConnection.js";

const reader = { parse: readLearningAi };
const when = (ms: number) => viewerTime(new Date(ms), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function CompanyKeyConnections() {
 const read = useAdminRead("learning-ai", LEARNING_AI_PATH, reader, { stable: true });
 return <section><p className="rv-muted">Agents can use any provider connected here. Hosted learning and answers currently need Anthropic. These keys are never used for your projects' tests.</p>
  {read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501 ? <AdminSection title="Learning AI key"><NotConnected what="Learning AI keys" /></AdminSection>
   : <ReadSection read={read} label="Company AI keys">{settings => <Settings settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>}
 </section>;
}

function Settings({ settings, reload }: { settings: LearningAiRead; reload: () => void }) {
 const query = useQueryClient();
 const context = useAdminContext();
 const change = useConnectionChange({ path: `${LEARNING_AI_PATH}/key`, readPath: LEARNING_AI_PATH, reader, revision: settings.revision, revisionOf: value => value.revision, reload });
 const { busy, notice } = change;
 // The card the person last pressed in shows the result beside its buttons; a result with no card (a Check on load) shows in the first card.
 const [acted, setActed] = useState<LearningProvider>();
 async function send(method: "PUT" | "DELETE", body: Record<string, unknown>, done: string) {
  if (typeof body["provider"] === "string") setActed(body["provider"] as LearningProvider);
  if (await change.send(method, body, done)) {
   await query.invalidateQueries({ queryKey: ["ai-spend", context.orgId, context.developerId, context.role, "agent-ai"], exact: true });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", "learning-ai"] }); reload();
  }
 }
 const noticeCard = acted !== undefined && settings.listed.includes(acted) ? acted : settings.listed[0];
 const reasons = new Map(settings.pauseReasons.map(r => [r.reason, r.message]));
 return <>
  {settings.listed.map(provider => <Account key={provider} provider={provider} settings={settings} busy={busy} locked={change.held} send={send}
   notice={provider === noticeCard && !change.held ? notice : undefined} held={<HeldConnection change={change} checkLabel={provider === "gemini" ? "Check Gemini key" : `Check ${LEARNING_PROVIDER_LABELS[provider].replace(" (agents only)", "")} key`} showNotice={provider === noticeCard} />} />)}
  <AdminSection title="Lessons" note={settings.pausedNow.length === 0 ? "No pause reported; model readiness is checked separately" : "Paused"}>
   {settings.learningCap === undefined ? <p>The learning cap isn't readable here.</p>
    : <p>Lessons may spend up to <b><Money usd={settings.learningCap.monthlyUsdMicros / 1_000_000} /></b> a month on learning{settings.learningCap.companyMonthlyUsdMicros === undefined ? "" : <>, inside the company's monthly cap of <Money usd={settings.learningCap.companyMonthlyUsdMicros / 1_000_000} /></>}. Change it in the company's budgets.</p>}
   {settings.pausedNow.length > 0 && <ul data-testid="paused-now">{settings.pausedNow.map(reason => <li key={reason}><VisibleText text={reasons.get(reason) ?? "Lessons are paused."} /></li>)}</ul>}
   <details><summary>Why lessons can be paused</summary><ul>{settings.pauseReasons.map(r => <li key={r.reason}><VisibleText text={r.message} /></li>)}</ul></details>
  </AdminSection>
 </>;
}

function Account({ provider, settings, busy, locked, send, notice, held }: { provider: LearningProvider; settings: LearningAiRead; busy: boolean; locked: boolean; notice: { ok: boolean; text: string } | undefined; held: ReactNode; send: (method: "PUT" | "DELETE", body: Record<string, unknown>, done: string) => Promise<void> }) {
 const a = settings.accounts[provider], title = LEARNING_PROVIDER_LABELS[provider], label = title.replace(" (agents only)", ""), removed = settings.removed.find(r => r.provider === provider);
 return <AdminSection title={title} note={a.connected ? (a.refusedAt === undefined ? "Connected" : "Refused") : "Not connected"}>
  {a.connected ? <p>A key is connected{a.updatedAt === undefined ? "" : `, last changed ${when(a.updatedAt)}`}. It is never shown here.{a.refusedAt === undefined ? "" : ` ${label} refused it at ${when(a.refusedAt)}: replace it.`}</p>
   : <p>No {label} key is connected.{removed === undefined ? "" : ` The last key was removed; it can be recovered until ${when(removed.recoverUntil)}.`}</p>}
  {provider === "openrouter" && <p className="rv-muted">Your agents use this key when you choose OpenRouter as their AI source (<Link to="/app/admin/ai-spending">AI and spending &gt; AI source order</Link>). Lessons and answers don't use it.</p>}
  {held}
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  <fieldset disabled={busy || locked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
  <SecretField label={a.connected ? `Replace the ${label} key` : `Paste the ${label} key`} submitLabel={a.connected ? "Replace key" : "Connect key"} allowFile validate={value => keyWhitespaceHint(value) ?? wrongProviderKeyHint(provider, value, settings.listed)} onSubmit={value => send("PUT", { provider, key: value.trim() }, a.connected ? "Key replaced." : "Key connected.")} />
  {a.connected && <p><Button busy={busy} variant="danger" onClick={() => { void send("DELETE", { provider }, `${label} key removed.`); }}>Remove {label} key</Button></p>}
  </fieldset>
 </AdminSection>;
}
