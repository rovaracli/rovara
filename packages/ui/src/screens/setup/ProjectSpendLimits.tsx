// Guided onboarding PR 15 (DEC 254l item 7): a project's "AI and spend limit". "Same as company" starts picked; "Set for this project" gives the
// project its own per-task limit (Code's per-project cost setting, through Cloud's /v1/app/projects/{p}/spend-limits). The project's monthly limit
// is the company's limit for every project today (no per-project monthly amount exists yet; see the build's Questions, PR 15), so it is shown as
// that and not editable here. Changing the per-task limit needs a fresh "confirm it's you" (Code checks it); every refusal shown is the server's own
// fixed sentence. PR 9 places this in Project settings; the admin project page shows it today.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dollarsOf, readSpendLimits, spendLimitsPath, type SpendLimitsRead } from "../../api/ai-spend.js";
import { needsStepUp } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { FreshSignIn, forgetConfirmed, useJustConfirmed } from "../admin/parts.js";

/** The most a per-task limit may be, in dollars (as Cloud allows). */
const PER_TASK_MAX_USD = 1_000_000;
export const PROJECT_SPEND_WORDS = Object.freeze({
 title: "AI and spend limit",
 same: "Same as company",
 sameText: "Each task is held to the company's per-task limit.",
 own: "Set for this project",
 perTask: "Per-task limit (USD)",
 badAmount: "The per-task limit must be an amount in dollars, like 5 or 12.50, up to 1,000,000.",
 monthly: "Monthly limit: the company's limit for each project. Company owners and admins set it in Company settings.",
 readOnly: "Only this project's admins can change it.",
 saved: "Saved. The new limit applies to the next task that starts.",
 action: "change this project's spending limits",
});
const W = PROJECT_SPEND_WORDS;
const money = (usd: number) => `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)}`;

export function ProjectSpendLimits({ project, developerId }: { project: string; developerId: string }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["spend-limits", developerId, project], queryFn: () => api.get(spendLimitsPath(project), { parse: readSpendLimits }), gcTime: 0, refetchOnWindowFocus: false });
 const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 return <section aria-label={W.title} data-testid="project-spend-limits"><h2>{W.title}</h2>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "project-spend-saved" : "project-spend-error"}><VisibleText text={notice.text} /></p>}
  {read.isPending ? <Skeleton label="Loading spending limits" /> : read.isError ? <><p data-testid="project-spend-unread">{read.error instanceof ApiError && read.error.status === 404 ? "This project's spending limits aren't available here." : "Couldn't load the spending limits. Try again."}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : <Limits key={`${read.data.project}:${String(read.data.revision)}`} limits={read.data} developerId={developerId} setNotice={setNotice} reload={() => { void read.refetch(); }} />}
 </section>;
}

function Limits({ limits, developerId, setNotice, reload }: { limits: SpendLimitsRead; developerId: string; setNotice: (n: { ok: boolean; text: string } | undefined) => void; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const confirmed = useJustConfirmed(developerId);
 const [same, setSame] = useState(limits.perTask.sameAsCompany);
 const [amount, setAmount] = useState(limits.perTask.usd === null ? "" : String(limits.perTask.usd));
 const [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
 const usd = dollarsOf(amount, PER_TASK_MAX_USD);
 const applied = limits.appliedUsd === undefined ? undefined : limits.appliedUsd === null ? "No fixed amount: Rovara's estimate for each task applies." : `Applies now: ${money(limits.appliedUsd)} a task.`;
 async function save() {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer("PUT", spendLimitsPath(limits.project), { expectedRevision: limits.revision, perTaskUsd: same ? null : usd }, { parse: readSpendLimits }, { retry: "never" });
   setNotice({ ok: true, text: W.saved }); reload();
  } catch (error) {
   if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); }
   else setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); }
 }
 if (!limits.canChange) {
  return <div data-testid="project-spend-read-only"><p>Per-task limit: <b>{limits.perTask.sameAsCompany ? W.same : limits.perTask.usd === null ? "No limit of its own" : money(limits.perTask.usd)}</b></p>{applied !== undefined && <p className="rv-muted">{applied}</p>}<p>{W.monthly}</p><p>{W.readOnly}</p></div>;
 }
 const ready = confirmed && !stale;
 return <>
  {!ready && <FreshSignIn action={W.action} refused={stale} />}
  <fieldset disabled={busy} aria-label="Per-task limit"><legend>Per-task limit</legend>
   <p><label data-testid="project-spend-same"><input type="radio" name="project-spend" checked={same} onChange={() => setSame(true)} /> <b>{W.same}</b>: {W.sameText}</label></p>
   <p><label data-testid="project-spend-own"><input type="radio" name="project-spend" checked={!same} onChange={() => setSame(false)} /> <b>{W.own}</b></label></p>
  </fieldset>
  {!same && <TextField label={W.perTask} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} {...(usd === undefined && amount !== "" ? { error: W.badAmount } : {})} />}
  {applied !== undefined && <p className="rv-muted" data-testid="project-spend-applied">{applied}</p>}
  <p>{W.monthly}</p>
  {ready && <p><Button variant="primary" busy={busy} disabled={!same && usd === undefined} onClick={() => { void save(); }}>Save</Button></p>}
 </>;
}
