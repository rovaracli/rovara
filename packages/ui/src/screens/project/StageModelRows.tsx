import { Link } from "react-router";
import { Select, type SelectOption } from "../../design/Select.js";
import { Switch } from "../../design/Switch.js";
import { VisibleText } from "../../design/VisibleText.js";
import { COMPANY_EFFORT_LEVELS, type StageModelsStage, type ThinkingLevel } from "../../api/stage-models.js";
import { HowWeWorkMarker } from "./HowWeWorkMarker.js";
import { COMPANY_PAGE, COST_TEXT, EFFORT_LABELS, REASON_LINE, REFUSAL_TEXT, REVIEWER_NAMES, candidateBlock } from "./stage-model-text.js";
import { DEFAULT_MODEL, baselineEffort, baselineModel, baselineVendor, stagesEditable, type EffortValue, type StageEdit } from "./how-we-work-models.js";
/** Only the levels the step settings accept today (the same list the company page offers); the full scale waits for lane C to widen the schema. */
const LEVELS: readonly ThinkingLevel[] = COMPANY_EFFORT_LEVELS;
const EFFORT_OPTIONS: readonly SelectOption[] = [{ value: "inherit", label: "Rovara's default" }, { value: "null", label: "Model default" }, ...LEVELS.map(level => ({ value: level, label: EFFORT_LABELS[level] }))];
const effortWords = (effort: ThinkingLevel | null): string => effort === null ? "Model default" : EFFORT_LABELS[effort];

/** The "Who does it" content of a stage card from the stage-models read: each stage's resolved result, and (when the person can edit and the stage is not locked) the model and effort pickers and the different-vendor toggle. A review card holds two reviewers' results and one picker. */
export function StageModelRows({ stages, reference, kind, viewerOnly, edit, disabled, onChange }: { stages: readonly StageModelsStage[]; reference: "Build" | "Plan" | undefined; kind: string; viewerOnly: boolean; edit: StageEdit | undefined; disabled: boolean; onChange: (patch: StageEdit) => void }) {
 const primary = stages[0]!, locked = stages.some(stage => stage.companyDefault.locked || (stage.result.kind === "effective" && stage.result.locked)), editable = !viewerOnly && stagesEditable(stages) && !locked;
 const labelOf = (model: string) => primary.candidates.find(candidate => candidate.model === model)?.label ?? stages.flatMap(stage => stage.candidates).find(candidate => candidate.model === model)?.label ?? model;
 const options: SelectOption[] = [{ value: DEFAULT_MODEL, label: "Rovara's default" }, ...(primary.candidatesState === "complete" ? primary.candidates.map(candidate => { const block = candidateBlock(candidate);return { value: candidate.model, label: block === undefined ? candidate.label : candidate.label + ": " + block, disabled: block !== undefined }; }) : [])];
 const current = edit?.model ?? baselineModel(primary);
 if (!options.some(option => option.value === current)) options.push({ value: current, label: labelOf(current), disabled: true });
 const conflict = stages.find(stage => stage.notice !== undefined && stage.projectChoice?.model !== undefined && stage.result.kind === "effective" && stage.projectChoice.model !== stage.result.model), lockHref = stages.find(stage => stage.notice !== undefined)?.notice?.fixHref ?? COMPANY_PAGE;
 const vendor = edit?.vendor ?? baselineVendor(primary), modelLabel = kind === "review" ? "Review (code and security)" : "Model";
 return <div className="rv-hww-models">
  {stages.map(stage => <div key={stage.stage} className="rv-hww-result" data-stage={stage.stage}>
   {stages.length > 1 && REVIEWER_NAMES[stage.stage] !== undefined && <p className="rv-muted">{REVIEWER_NAMES[stage.stage]}</p>}
   {stage.result.kind === "effective" ? <>
    <p><span className="rv-hww-text"><VisibleText text={labelOf(stage.result.model)} /></span> <HowWeWorkMarker mark={{ source: stage.result.decidedBy, locked: stage.result.locked, ...(stage.result.locked ? { lockedBy: "company" } : {}) }} /> <span className="rv-muted">Effort: {effortWords(stage.result.effort)}</span></p>
    <p className="rv-muted">{"Picked because: " + REASON_LINE[stage.result.reason]}</p>
   </> : stage.result.kind === "refusal" ? <p role="status"><VisibleText text={REFUSAL_TEXT[stage.result.code]} />{stage.result.fixHref !== undefined && <> <Link to={stage.result.fixHref}>How to fix this</Link></>}</p> : <p className="rv-muted">This stage does not use a model.</p>}
  </div>)}
  {conflict !== undefined && conflict.projectChoice?.model !== undefined && <p>{"Your project's choice (" + labelOf(conflict.projectChoice.model) + ") isn't used while the company locks this stage."}</p>}
  {locked && <p>Locked by company. <Link to={lockHref}>Company How we work</Link></p>}
  {editable && <div className="rv-hww-pickers">
   <Select label={modelLabel} value={current} options={options} disabled={disabled} onValueChange={value => onChange({ model: value })} />
   {primary.candidatesState !== "complete" && <p className="rv-muted">The list of models isn't available right now.</p>}
   <Select label="Effort" value={edit?.effort ?? baselineEffort(primary)} options={EFFORT_OPTIONS} disabled={disabled} onValueChange={value => onChange({ effort: value as EffortValue })} />
   {reference !== undefined && <Switch label={"Different vendor than " + reference} checked={vendor} disabled={disabled} onCheckedChange={checked => onChange({ vendor: checked })} />}
  </div>}
  {!editable && !viewerOnly && !locked && primary.result.kind !== "not_applicable" && <p className="rv-muted">The model for this stage can't be changed here.</p>}
  {!editable && reference !== undefined && baselineVendor(primary) && <p className="rv-muted">{"Must be a different vendor than " + reference + "."}</p>}
  <p className="rv-muted">{COST_TEXT}</p>
 </div>;
}
