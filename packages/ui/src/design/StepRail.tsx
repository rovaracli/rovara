import type { ReadTask, Step, Tone } from "../api/work.js";
import { sectionState, STEPS } from "../api/work.js";

const WORDS: Record<Tone, string> = { wait: "needs you", run: "running", ok: "done", bad: "failed", idle: "waiting" };

/**
 * The five steps of a task (Request, Spec, Build, Proof, Pull request): the "you are here" control. `onSelect` makes each step a button that shows that stage;
 * without it the steps are plain text. Only a served running step is marked with `aria-current="step"`, a ✓ only where the served stage and the fixed stage order prove a step finished and no served result in it failed (a failed one shows ✕, needs attention; see sectionState), and every step says its state in words, not only in colour.
 */
export function StepRail({ tone, task, selected, onSelect, failed }: { step: Step; tone: Tone; task?: ReadTask | undefined; /** Sections whose served results include a failure (failedSections): not finished, they need attention. */ failed?: ReadonlySet<Step> | undefined; /** The step whose stage the pane shows, when it is not the current one. */ selected?: Step | undefined; onSelect?: ((step: Step) => void) | undefined }) {
 return <ol className="rv-step-rail" aria-label="Steps of this task">{STEPS.map(entry => {
  const state = sectionState(task, entry.step, failed), words = state === "attention" ? "needs attention" : state === "done" ? "finished" : state === "current" ? "running" : state === "blocked" ? "blocked" : state === "waiting" ? "needs you" : entry.step === "request" ? "submitted" : "progress not confirmed";
  const content = <><span aria-hidden="true">{state === "attention" ? "✕\u00a0" : state === "done" ? "✓\u00a0" : state === "current" ? "●\u00a0" : state === "blocked" ? "!\u00a0" : ""}</span>{entry.label}<span className="rv-visually-hidden">, {words}</span></>;
  const className = `rv-step ${state === "done" ? "ok" : state === "current" ? tone : state === "blocked" || state === "attention" ? "bad" : ""}`;
  return <li key={entry.step} className={className} data-state={state} {...(selected === entry.step ? { "data-selected": "true" } : {})}>{onSelect === undefined
   ? <span aria-current={state === "current" ? "step" : undefined}>{content}</span>
   : <button type="button" aria-current={state === "current" ? "step" : undefined} aria-pressed={selected === entry.step} onClick={() => onSelect(entry.step)}>{content}</button>}</li>;
 })}</ol>;
}

/** The same five steps as five small bars, for a list row. The title and label say where the task is, for a screen reader. */
export function StepMini({ step, tone }: { step: Step; tone: Tone }) {
 const at = step === "merged" ? STEPS.length : step === "closed" ? -1 : STEPS.findIndex(entry => entry.step === step), name = step === "merged" ? "Merged" : step === "closed" ? "Closed" : STEPS[at]!.label;
 const label = `${name}${step === "merged" || step === "closed" ? "" : ", " + WORDS[tone]}`;
 return <span className="rv-step-mini" role="img" aria-label={label} title={label}>{STEPS.map((entry, index) => <i key={entry.step} className={index < at ? "d" : index === at ? tone : ""} />)}</span>;
}
