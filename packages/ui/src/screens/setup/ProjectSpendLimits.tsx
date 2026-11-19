// The project page edits its task limit; monthly limits live on Spending limits.
import { Link } from "react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dollarsOf, readSpendLimits, spendLimitsPath, type SpendLimitsRead } from "../../api/ai-spend.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";

/** The most a per-task limit may be, in dollars (as Cloud allows). */
const PER_TASK_MAX_USD = 1_000_000;
export const PROJECT_SPEND_WORDS = Object.freeze({
 title: "AI and spend limit",
 same: "Same as company",
 sameText: "Each task is held to the company's per-task limit.",
 own: "Set for this project",
 perTask: "Per-task limit (USD)",
 badAmount: "The per-task limit must be an amount in dollars, like 5 or 12.50, up to 1,000,000.",
 monthly: "Monthly limits for each project are set by company owners and admins on Spending limits.",
 readOnly: "Only this project's admins can change it.",
 saved: "Saved. The new limit applies to the next task that starts.",
});
const W = PROJECT_SPEND_WORDS;
const money = (usd: number) => `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)}`;

export function ProjectSpendLimits({ project, developerId }: { project: string; developerId: string }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["spend-limits", developerId, project], queryFn: () => api.get(spendLimitsPath(project), { parse: readSpendLimits }), gcTime: 0, refetchOnWindowFocus: false });
 const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 return <section aria-label={W.title} data-testid="project-spend-limits"><h2>{W.title}</h2>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "project-spend-saved" : "project-spend-error"}><VisibleText text={notice.text} /></p>}
  {read.isPending ? <Skeleton label="Loading spending limits" /> : read.isError ? <><p role="status" data-testid="project-spend-unread">{read.error instanceof ApiError && read.error.status === 404 ? "This project's spending limits aren't available here." : "Couldn't load the spending limits. Try again."}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : <Limits key={`${read.data.project}:${String(read.data.revision)}`} limits={read.data} setNotice={setNotice} reload={() => { void read.refetch(); }} />}
 </section>;
}

function Limits({ limits, setNotice, reload }: { limits: SpendLimitsRead; setNotice: (n: { ok: boolean; text: string } | undefined) => void; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [same, setSame] = useState(limits.perTask.sameAsCompany);
 const [amount, setAmount] = useState(limits.perTask.usd === null ? "" : String(limits.perTask.usd));
 const [busy, setBusy] = useState(false);
 const usd = dollarsOf(amount, PER_TASK_MAX_USD);
 const applied = limits.appliedUsd === undefined ? undefined : limits.appliedUsd === null ? "No fixed amount: Rovara's estimate for each task applies." : `Applies now: ${money(limits.appliedUsd)} a task.`;
 async function save() {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer("PUT", spendLimitsPath(limits.project), { expectedRevision: limits.revision, perTaskUsd: same ? null : usd }, { parse: readSpendLimits }, { retry: "never" });
   setNotice({ ok: true, text: W.saved }); reload();
  } catch (error) {
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); }
 }
 if (!limits.canChange) {
  return <div data-testid="project-spend-read-only"><p>Per-task limit: <b>{limits.perTask.sameAsCompany ? W.same : limits.perTask.usd === null ? "No limit of its own" : money(limits.perTask.usd)}</b></p>{applied !== undefined && <p className="rv-muted">{applied}</p>}<p>{W.monthly} <Link to="/app/admin/money/limits">Open Spending limits</Link>.</p><p>{W.readOnly}</p></div>;
 }
 return <>
  <fieldset disabled={busy} aria-label="Per-task limit"><legend>Per-task limit</legend>
   <p><label data-testid="project-spend-same"><input type="radio" name="project-spend" checked={same} onChange={() => setSame(true)} /> <b>{W.same}</b>: {W.sameText}</label></p>
   <p><label data-testid="project-spend-own"><input type="radio" name="project-spend" checked={!same} onChange={() => setSame(false)} /> <b>{W.own}</b></label></p>
  </fieldset>
  {!same && <TextField label={W.perTask} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} {...(usd === undefined && amount !== "" ? { error: W.badAmount } : {})} />}
  {applied !== undefined && <p className="rv-muted" data-testid="project-spend-applied">{applied}</p>}
  <p>{W.monthly} <Link to="/app/admin/money/limits">Open Spending limits</Link>.</p>
  <p><Button variant="primary" busy={busy} disabled={!same && usd === undefined} onClick={() => { void save(); }}>Save</Button></p>
 </>;
}
