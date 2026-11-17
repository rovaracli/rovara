// The Cost and time actions (lane L4-CR4): New feature, Rename, Merge into, Mark done or reopen, and Move to feature. Each asks for a confirm that says what will change, then sends one change to Cloud,
// which passes it to Rovara Code as the person. Code decides: a refusal is Cloud's fixed sentence, shown here as it came, and the page reads again so it shows what is true now. A button is drawn
// only where there is something it can do (the pages draw these only when Cloud said the person may change features, and a button with no target is not drawn at all).
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { createReportActions, type PickerFeature } from "../../../api/admin-report.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";

export const FEATURE_NAME_MAX = 80;
const NO_FEATURE_CHOICE = "__none__";
const FAILED = "That change couldn't be made. Try again.";

/** Cloud's calls for the five changes, and the way to read the report again after one. */
function useReportChange() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createReportActions(host), [host]);
 return { api, reload: () => query.invalidateQueries({ queryKey: ["admin", "report"] }) };
}

/**
 * A native menu whose first choice is an ordinary, selectable "Choose a feature" (the confirm stays off until a real choice is made). The design Select draws its placeholder as a disabled
 * option, which the browser greys below the contrast the app holds itself to.
 */
function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string }> }) {
 const id = useId();
 return <div className="rv-field"><label htmlFor={id}>{label}</label><select id={id} className="rv-input rv-select-trigger" value={value} onChange={event => onChange(event.target.value)}>
  <option value="">Choose a feature</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
 </select></div>;
}

/** A feature name as typed: one line, at most 80 characters, not empty. The hint says which. */
export function nameProblem(value: string): string | undefined {
 const name = value.trim();
 if (name === "") return "Give the feature a name.";
 if (Array.from(name).length > FEATURE_NAME_MAX) return `Use at most ${FEATURE_NAME_MAX} characters.`;
 if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return "Use plain text on one line.";
 return undefined;
}

/**
 * A button that opens a confirm. `run` makes the change; on success the confirm closes and `done` runs; on a refusal the confirm stays open with Cloud's fixed sentence, and the page is read
 * again. One press sends one change.
 */
function Action({ label, triggerLabel, reset, title, description, confirm, danger = false, canConfirm = true, run, done, children, variant = "secondary" }: {
 label: string; triggerLabel?: string; /** Puts the form back as it was (runs when the confirm closes). */ reset?: () => void; title: string; description: string; confirm: string; danger?: boolean; canConfirm?: boolean; variant?: "primary" | "secondary" | "quiet";
 run: () => Promise<unknown>; done?: () => void; children?: ReactNode;
}) {
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string>(), sending = useRef(false);
 const { reload } = useReportChange();
 async function submit() {
  if (sending.current || !canConfirm) return;
  sending.current = true; setBusy(true); setMessage(undefined);
  try { await run(); }
  catch (error) { setMessage(error instanceof ApiError ? error.message : FAILED); await reload().catch(() => undefined); sending.current = false; setBusy(false); return; }
  // The change was made: close, go on (a merge opens the other feature), then read again so the page shows what is true now. A failed read is not a failed change.
  sending.current = false; setBusy(false); setOpen(false); reset?.(); done?.();
  await reload().catch(() => undefined);
 }
 return <Dialog title={title} description={description} open={open} onOpenChange={value => { if (!sending.current) { setOpen(value); if (!value) { setMessage(undefined); reset?.(); } } }}
  trigger={<Button variant={variant} {...(triggerLabel === undefined ? {} : { "aria-label": triggerLabel })}>{label}</Button>}>
  <form className="rv-report-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
   {children}
   {message !== undefined && <p role="alert" className="rv-error" data-testid="report-action-error"><VisibleText text={message} /></p>}
   <div className="rv-report-form-buttons">
    <Button variant={danger ? "danger" : "primary"} busy={busy} disabled={!canConfirm} onClick={() => { void submit(); }}>{confirm}</Button>
   </div>
  </form>
 </Dialog>;
}

/** New feature: a name, then the feature's own page opens. */
export function NewFeatureButton({ onCreated }: { onCreated: (id: string) => void }) {
 const { api } = useReportChange(), [name, setName] = useState(""), created = useRef<string | undefined>(undefined);
 return <Action label="New feature" title="New feature" description="A feature groups tasks so their cost and time add up together. Tasks join it when you move them here or choose it when they start." confirm="Make feature"
  canConfirm={nameProblem(name) === undefined} reset={() => setName("")} run={async () => { created.current = (await api.create(name.trim())).feature.id; }} done={() => { if (created.current !== undefined) onCreated(created.current); }}>
  <TextField label="Feature name" value={name} onChange={event => setName(event.target.value)} hint={`One line, at most ${FEATURE_NAME_MAX} characters.`} autoComplete="off" maxLength={200} />
 </Action>;
}

/** Rename: the name changes everywhere; no task or number does. */
export function RenameButton({ feature }: { feature: PickerFeature }) {
 const { api } = useReportChange(), [name, setName] = useState(feature.name);
 const problem = nameProblem(name), same = name.trim() === feature.name;
 return <Action label="Rename" title="Rename feature" description="The new name shows everywhere. Its tasks and numbers do not change." confirm="Rename" canConfirm={problem === undefined && !same} reset={() => setName(feature.name)}
  run={() => api.rename(feature.id, name.trim())}>
  <TextField label="Feature name" value={name} onChange={event => setName(event.target.value)} hint={`One line, at most ${FEATURE_NAME_MAX} characters.`} autoComplete="off" maxLength={200} />
 </Action>;
}

/** Merge into: every task of this feature counts under the one chosen. Not drawn when there is no other feature. */
export function MergeButton({ feature, others, onMerged }: { feature: PickerFeature; others: readonly PickerFeature[]; onMerged: (into: string) => void }) {
 const { api } = useReportChange(), [into, setInto] = useState(""), chosen = others.find(other => other.id === into);
 if (others.length === 0) return null;
 return <Action label="Merge into" title="Merge into another feature" description="Every task in this feature will count under the one you choose, and this feature goes away. No task history is rewritten. A merged feature can't be brought back." confirm="Merge" danger canConfirm={chosen !== undefined} reset={() => setInto("")}
  run={() => api.mergeInto(feature.id, into)} done={() => onMerged(into)}>
  <Choice label="Merge into" value={into} onChange={setInto} options={others.map(other => ({ value: other.id, label: other.state === "done" ? `${other.name} (done)` : other.name }))} />
 </Action>;
}

/** Mark done or reopen: a done feature takes no new tasks until it is reopened. Not drawn while Code gives no state. */
export function StateButton({ feature }: { feature: PickerFeature }) {
 const { api } = useReportChange();
 if (feature.state === undefined) return null;
 const closing = feature.state === "open";
 return <Action label={closing ? "Mark done" : "Reopen"} title={closing ? "Mark feature done" : "Reopen feature"}
  description={closing ? "A done feature takes no new tasks until you reopen it. Its tasks and numbers stay." : "The feature takes new tasks again."} confirm={closing ? "Mark done" : "Reopen"}
  run={() => api.setState(feature.id, closing ? "done" : "open")} />;
}

/**
 * Move to feature, on a task row. The choices are the features that take tasks (not done, not the one it is in) and "No feature" when it is in one. Not drawn when there is no choice.
 */
export function MoveButton({ task, current, features }: { task: { taskId: string; title: string }; current: string | undefined; features: readonly PickerFeature[] }) {
 const { api } = useReportChange(), [to, setTo] = useState("");
 const targets = features.filter(feature => feature.id !== current && feature.state !== "done");
 const options = [...targets.map(feature => ({ value: feature.id, label: feature.name })), ...(current === undefined ? [] : [{ value: NO_FEATURE_CHOICE, label: "No feature" }])];
 if (options.length === 0) return null;
 return <Action label="Move" triggerLabel={`Move ${task.title} to a feature`} title="Move to feature" description={`"${task.title}" will count under the feature you choose from now on, with all of its cost. Other tasks do not change.`} confirm="Move task" canConfirm={options.some(option => option.value === to)} reset={() => setTo("")}
  run={() => api.moveTask(task.taskId, to === NO_FEATURE_CHOICE ? null : to)} variant="quiet">
  <Choice label="Move to feature" value={to} onChange={setTo} options={options} />
 </Action>;
}
