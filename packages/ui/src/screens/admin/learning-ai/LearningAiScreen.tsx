// Learning AI key (PRODUCT-LEARNING-CONNECT-ROUTE, DEC 226): the company's own AI provider account that lessons' learning calls run on, the
// company's monthly learning cap, and why lessons are or may be paused. Company admins only. The key is write-only: typed once, sent, never shown
// back. Company admins only, which the server checks too. It is never a project's key and is never used for a project's tests.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LEARNING_AI_PATH, LEARNING_PROVIDER_LABELS, readLearningAi, type LearningAiRead, type LearningProvider } from "../../../api/admin-learning-ai.js";
import { isNotConnected } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { SecretField } from "../../../design/SecretField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, NotConnected } from "../parts.js";

const reader = { parse: readLearningAi };
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";

export function CompanyKeyConnections() {
 const read = useAdminRead("learning-ai", LEARNING_AI_PATH, reader, { stable: true });
 return <section><p>Company AI keys are write-only. They are never project test keys. Task work can use connected providers; hosted learning and answers currently require Anthropic, with a restricted Rovara fallback for eligible exempt companies.</p>
  {read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501 ? <AdminSection title="Learning AI key"><NotConnected what="Learning AI keys" /></AdminSection>
   : <ReadSection read={read} label="Company AI keys">{settings => <Settings settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>}
 </section>;
}

function Settings({ settings, reload }: { settings: LearningAiRead; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 async function send(method: "PUT" | "DELETE", body: Record<string, unknown>, done: string) {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer(method, `${LEARNING_AI_PATH}/key`, { requestId: crypto.randomUUID(), expectedRevision: settings.revision, ...body }, { parse: answer => answer }, { retry: "never" });
   setNotice({ ok: true, text: done });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", "learning-ai"] }); reload();
  } catch (error) {
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); }
 }
 const reasons = new Map(settings.pauseReasons.map(r => [r.reason, r.message]));
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  <AdminSection title="Lessons" note={settings.pausedNow.length === 0 ? "No pause reported; model readiness is checked separately" : "Paused"}>
   {settings.learningCap === undefined ? <p>The learning cap isn't readable here.</p>
    : <p>Lessons may spend up to <b><Money usd={settings.learningCap.monthlyUsdMicros / 1_000_000} /></b> a month on learning{settings.learningCap.companyMonthlyUsdMicros === undefined ? "" : <>, inside the company's monthly cap of <Money usd={settings.learningCap.companyMonthlyUsdMicros / 1_000_000} /></>}. Change it in the company's budgets.</p>}
   {settings.pausedNow.length > 0 && <ul data-testid="paused-now">{settings.pausedNow.map(reason => <li key={reason}><VisibleText text={reasons.get(reason) ?? "Lessons are paused."} /></li>)}</ul>}
   <details><summary>Why lessons can be paused</summary><ul>{settings.pauseReasons.map(r => <li key={r.reason}><VisibleText text={r.message} /></li>)}</ul></details>
  </AdminSection>
  {settings.listed.map(provider => <Account key={provider} provider={provider} settings={settings} busy={busy} send={send} />)}
 </>;
}

function Account({ provider, settings, busy, send }: { provider: LearningProvider; settings: LearningAiRead; busy: boolean; send: (method: "PUT" | "DELETE", body: Record<string, unknown>, done: string) => Promise<void> }) {
 const a = settings.accounts[provider], label = LEARNING_PROVIDER_LABELS[provider], removed = settings.removed.find(r => r.provider === provider);
 return <AdminSection title={label} note={a.connected ? (a.refusedAt === undefined ? "Connected" : "Refused") : "Not connected"}>
  {a.connected ? <p>A key is connected{a.updatedAt === undefined ? "" : `, last changed ${when(a.updatedAt)}`}. It is never shown here.{a.refusedAt === undefined ? "" : ` ${label} refused it at ${when(a.refusedAt)}: replace it.`}</p>
   : <p>No {label} key is connected.{removed === undefined ? "" : ` The last key was removed; it can be recovered until ${when(removed.recoverUntil)}.`}</p>}
  <SecretField label={a.connected ? `Replace the ${label} key` : `Paste the ${label} key`} submitLabel={a.connected ? "Replace key" : "Connect key"} onSubmit={value => send("PUT", { provider, key: value.trim() }, a.connected ? "Key replaced." : "Key connected.")} />
  {a.connected && <p><Button busy={busy} onClick={() => { void send("DELETE", { provider }, `${label} key removed.`); }}>Remove {label} key</Button></p>}
 </AdminSection>;
}
