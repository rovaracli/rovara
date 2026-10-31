import { useEffect, useMemo, useState } from "react";
import { formatUsdMicrodollars, taskStopEditKind, TaskStopCompanyPolicySchema, TaskStopProjectPolicySchema, type TaskStopEditablePolicy } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createTaskStopEditingApi } from "../../api/task-stop-editing.js";
import { Button } from "../../design/Button.js";
import { TextField } from "../../design/TextField.js";
import { Select } from "../../design/Select.js";
import { useAdminContext } from "./AdminLayout.js";
const describe = (policy: TaskStopEditablePolicy) => policy.kind === "limited" ? formatUsdMicrodollars(policy.stopMicrousd) : policy.kind === "inherit" ? "Inherit the company task stop" : "Use Rovara's estimate for each task";
function originalPolicy(value: unknown): TaskStopEditablePolicy {
 const company = TaskStopCompanyPolicySchema.safeParse(value);
 if (company.success) return company.data.schemaVersion === 1 ? { kind: "limited", stopMicrousd: company.data.defaultStopMicrousd } : company.data.defaultPolicy;
 const project = TaskStopProjectPolicySchema.parse(value);return project.schemaVersion === 1 ? { kind: "limited", stopMicrousd: project.stopMicrousd } : { kind: "inherit" };
}
function exactAmount(value: string): number | undefined {
 if (value.length > 14 || !/^\d+(?:\.\d{1,6})?$/.test(value)) return undefined;
 const [whole, fraction = ""] = value.split("."), micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
 return micros <= 1_000_000_000_000n ? Number(micros) : undefined;
}
export function TaskStopEditor() {
 const { orgId, developerId, role, checking } = useAdminContext();
 const [project, setProject] = useState(""), [selected, setSelected] = useState<{ project?: string; id: number }>();
 return <section className="rv-admin-section"><h2>Task stops</h2><p>Task stop settings apply to future admissions when task-stop enforcement is enabled for the company. Existing running limits stay in place. Monthly budgets are separate.</p>
  <Button disabled={checking} onClick={() => { setSelected(previous => ({ id: (previous?.id ?? 0) + 1 })); }}>Load company task stop</Button>
  <TextField label="Project name for task stop" value={project} onChange={event => { setProject(event.target.value); }} />
  <Button disabled={checking || project.trim() === ""} onClick={() => { setSelected(previous => ({ project: project.trim(), id: (previous?.id ?? 0) + 1 })); }}>Load project task stop</Button>
  {selected !== undefined && <ScopedEditor key={`${orgId}:${developerId}:${role}:${selected.project ?? "company"}:${selected.id}`} orgId={orgId} developerId={developerId} {...(selected.project === undefined ? {} : { project: selected.project })} checking={checking} />}
 </section>;
}
function ScopedEditor({ orgId, developerId, project, checking }: { orgId: string; developerId: string; project?: string; checking: boolean }) {
 const host = useAppHost(), api = useMemo(() => createTaskStopEditingApi(host, orgId, project), [host, orgId, project]);
 const [context, setContext] = useState<Awaited<ReturnType<typeof api.get>>>(), [busy, setBusy] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState("");
 const [kind, setKind] = useState("limited"), [amount, setAmount] = useState(""), [review, setReview] = useState<{ policy: TaskStopEditablePolicy; requestId: string }>();
 useEffect(() => {
  let live = true;api.setScopeActive(true);
  void api.get().then(value => { if (live) { setContext(value);setKind(value.policy.kind);setAmount(value.policy.kind === "limited" ? String(value.policy.stopMicrousd / 1_000_000) : ""); } }).catch(() => { if (live) setError("Couldn't check this task stop. Reload and review current access and settings."); }).finally(() => { if (live) setBusy(false); });
  return () => { live = false;api.setScopeActive(false); };
 }, [api]);
 const locked = busy || checking;
 async function write(decision?: "approve" | "reject" | "cancel") {
  if (locked || context === undefined || (decision === undefined && review === undefined)) return;
  setBusy(true);setError("");
  try {
   const result = decision === undefined ? await api.edit({ requestId: review!.requestId, expectedRevision: context.revision, expectedPolicyDigest: context.sourceDigest, policy: review!.policy })
    : await api.decide({ requestId: crypto.randomUUID(), proposalId: context.pending!.proposalId, expectedProposalDigest: context.pending!.proposalDigest, decision });
   setMessage(result.state === "pending" ? "Task stop change requested. The current policy stays in place until a different authorized person approves." : result.state === "applied" ? "Task stop change applied. Existing running limits stay in place." : `Task stop change ${result.state}.`);
   setReview(undefined);setContext(undefined);const fresh = await api.get();setContext(fresh);setKind(fresh.policy.kind);setAmount(fresh.policy.kind === "limited" ? String(fresh.policy.stopMicrousd / 1_000_000) : "");
  } catch { setContext(undefined);setReview(undefined);setError("Couldn't confirm current Spending settings. Reload the task stop before making another change."); }
  finally { setBusy(false); }
 }
 function prepare() {
  if (locked || context === undefined) return;
  const micros = exactAmount(amount);
  if (kind === "limited" && micros === undefined) { setError("Enter a non-negative USD amount with at most six decimal places, up to 1000000.");return; }
  const policy: TaskStopEditablePolicy = kind === "limited" ? { kind: "limited", stopMicrousd: micros! } : project === undefined ? { kind: "rovara_estimate" } : { kind: "inherit" };
  setError("");setReview({ policy, requestId: crypto.randomUUID() });
 }
 return <section aria-busy={locked} className="rv-admin-section"><h3>{project === undefined ? "Company task stop" : `Task stop for ${project}`}</h3>
  {busy && <p role="status">Checking task stop...</p>}{error !== "" && <p role="alert">{error}</p>}{message !== "" && <p role="status">{message}</p>}
  {context !== undefined && <>{context.sourceState === "missing" && <p>Project spending settings are missing. Review a policy to initialize them before work can be admitted.</p>}{context.lastTaskStopChange?.state === "expired" && <p role="status">The previous loosening request expired because a tightening was applied.</p>}{context.seedReview?.reviewRequired === true && <p>This company policy was seeded during {context.seedReview.source}. Company review is required; no fixed USD amount is implied by Rovara’s estimate.</p>}<p>Current task stop: {describe(context.policy)}. Revision {context.revision}.</p>
   {context.pending !== undefined ? <><h4>Pending task stop change</h4><p>Original task stop: {describe(originalPolicy(context.pending.beforePolicy))}.</p><p>Proposed task stop: {describe(context.pending.proposedPolicy)}.</p><p>Requested by {context.pending.requestedBy} on {new Date(context.pending.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. Approval uses these original terms and fresh access checks.</p>
    {context.pending.requestedBy === developerId ? <Button disabled={locked} onClick={() => { void write("cancel"); }}>Cancel my task stop request</Button> : <Button disabled={locked} onClick={() => { void write("approve"); }}>Approve original task stop change</Button>}
    <Button disabled={locked} onClick={() => { void write("reject"); }}>Reject task stop change</Button></> : null}<>
    <Select label="Task stop policy" value={kind} disabled={locked} onValueChange={value => { setKind(value);setReview(undefined); }} options={[{ value: "limited", label: "Set a USD task stop" }, project === undefined ? { value: "rovara_estimate", label: "Use Rovara's estimate" } : { value: "inherit", label: "Inherit company task stop" }]} />
    {kind === "limited" && <TextField label="Task stop amount (USD)" inputMode="decimal" maxLength={14} value={amount} disabled={locked} hint="Zero is an explicit stop setting. Up to six decimal places." onChange={event => { setAmount(event.target.value);setReview(undefined); }} />}
    <Button disabled={locked} onClick={prepare}>Review task stop change</Button>
    {review !== undefined && <><h4>Review task stop settings</h4><p>Original task stop: {describe(context.policy)}.</p><p>New task stop: {describe(review.policy)}.</p><p>{taskStopEditKind(context.policy, review.policy) === "loosening" ? "A different current company owner or admin must approve this loosening. The current policy stays in place." : "These settings apply to future admissions when task-stop enforcement is enabled, after the server checks current access and original settings."}</p>
     <Button disabled={locked} onClick={() => { void write(); }}>{context.sourceState === "missing" ? "Initialize task stop settings" : taskStopEditKind(context.policy, review.policy) === "loosening" ? "Request loosening" : taskStopEditKind(context.policy, review.policy) === "unchanged" ? "Confirm unchanged policy" : "Apply tightening"}</Button></>}
   </>
  </>}
 </section>;
}
