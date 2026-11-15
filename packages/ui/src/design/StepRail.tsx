import type { Step, Tone } from "../api/work.js";
import { STEPS } from "../api/work.js";

/** Where a step stands: done (a tick), current (a dot in the task's tone) or not started (plain). */
function stateOf(index: number, step: Step, tone: Tone): "done" | "current" | "todo" {
 const at = step === "merged" ? STEPS.length : STEPS.findIndex(entry => entry.step === step);
 return index < at ? "done" : index === at ? (tone === "ok" && step === "merged" ? "done" : "current") : "todo";
}
const WORDS: Record<Tone, string> = { wait: "needs you", run: "running", ok: "done", bad: "failed", idle: "waiting" };

/**
 * The five steps of a task (Request, Spec, Build, Proof, Pull request): the "you are here" control. `onSelect` makes each step a button that shows that stage;
 * without it the steps are plain text. The current step is marked with `aria-current="step"`, and every step says its state in words, not only in colour.
 */
export function StepRail({ step, tone, selected, onSelect }: { step: Step; tone: Tone; /** The step whose stage the pane shows, when it is not the current one. */ selected?: Step | undefined; onSelect?: ((step: Step) => void) | undefined }) {
 return <ol className="rv-step-rail" aria-label="Steps of this task">{STEPS.map((entry, index) => {
  const state = stateOf(index, step, tone), words = state === "done" ? "done" : state === "current" ? WORDS[tone] : "not started";
  const content = <><span aria-hidden="true">{state === "done" ? "✓ " : state === "current" ? "● " : ""}</span>{entry.label}<span className="rv-visually-hidden">, {words}</span></>;
  const className = `rv-step ${state === "done" ? "d" : state === "current" ? tone : ""}`;
  return <li key={entry.step} className={className} data-state={state} {...(selected === entry.step ? { "data-selected": "true" } : {})}>{onSelect === undefined
   ? <span aria-current={state === "current" ? "step" : undefined}>{content}</span>
   : <button type="button" aria-current={state === "current" ? "step" : undefined} aria-pressed={selected === entry.step} onClick={() => onSelect(entry.step)}>{content}</button>}</li>;
 })}</ol>;
}

/** The same five steps as five small bars, for a list row. The title and label say where the task is, for a screen reader. */
export function StepMini({ step, tone }: { step: Step; tone: Tone }) {
 const at = step === "merged" ? STEPS.length : STEPS.findIndex(entry => entry.step === step), name = step === "merged" ? "Merged" : STEPS[at]!.label;
 const label = `${name}${step === "merged" ? "" : ", " + WORDS[tone]}`;
 return <span className="rv-step-mini" role="img" aria-label={label} title={label}>{STEPS.map((entry, index) => <i key={entry.step} className={index < at ? "d" : index === at ? tone : ""} />)}</span>;
}
