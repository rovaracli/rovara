import { Link } from "react-router";
import { Select, type SelectOption } from "../../design/Select.js";
import { Switch } from "../../design/Switch.js";
import { VisibleText } from "../../design/VisibleText.js";
import { modelKey, stageResult, type StageModelsStage, type ThinkingLevel } from "../../api/stage-models.js";
import { editBaseStage, usesBaseSetting } from "../../api/stage-cards.js";
import { HowWeWorkMarker } from "./HowWeWorkMarker.js";
import { COMPANY_PAGE, COST_TEXT, EFFORT_OPTIONS, STAGE_NAMES, candidateBlock, checkingReasonLine, effortLabel, isCheckingStage, noOtherCompanyText, otherCompanyFailedText, reasonLine, refusalText } from "./stage-model-text.js";
import { DEFAULT_MODEL, baselineEffort, baselineModel, applicableStages, baselineVendor, explicitVendor, stagesEditable, type EffortValue, type StageEdit } from "./how-we-work-models.js";
const effortWords = (effort: ThinkingLevel | null): string => effort === null ? "Model default" : effortLabel(effort);

/** The "Who does it" content of a stage card from the stage-models read: each stage's resolved result, and (when the person can edit and the stage is not locked) the model and effort pickers and the different-vendor toggle. A card can hold several stages' results (two reviewers; Understand with Plan) and one picker, which edits the stage that names the group. */
export function StageModelRows({ stages, reference, kind, viewerOnly, edit, disabled, onChange }: { stages: readonly StageModelsStage[]; reference: "Build" | "Plan" | undefined; kind: string; viewerOnly: boolean; edit: StageEdit | undefined; disabled: boolean; onChange: (patch: StageEdit) => void }) {
 const applicable = applicableStages(stages), primary = applicable.find(stage => stage.stage === editBaseStage(stages.map(entry => entry.stage))) ?? applicable[0] ?? stages[0]!, locked = applicable.some(stage => stage.locked || ("effective" in stage && stage.effective.locked)), editable = !viewerOnly && stagesEditable(stages) && !locked;
 const labelOf = (model: string) => primary.candidates.find(candidate => modelKey(candidate.model) === model)?.label ?? stages.flatMap(stage => stage.candidates).find(candidate => modelKey(candidate.model) === model)?.label ?? model;
 const options: SelectOption[] = [{ value: DEFAULT_MODEL, label: "Rovara's default" }, ...(primary.candidatesState === "complete" ? primary.candidates.map(candidate => { const block = candidateBlock(candidate);return { value: modelKey(candidate.model), label: block === undefined ? candidate.label : candidate.label + ": " + block, disabled: block !== undefined }; }) : [])];
 const current = edit?.model ?? baselineModel(primary);
 if (!options.some(option => option.value === current)) options.push({ value: current, label: labelOf(current), disabled: true });
 const conflict = stages.find(stage => stage.notice !== undefined && stage.projectChoice?.model !== undefined && "effective" in stage && modelKey(stage.projectChoice.model) !== modelKey(stage.effective.model)), lockHref = stages.find(stage => stage.notice !== undefined)?.notice?.fixHref ?? COMPANY_PAGE;
 const effortValue = edit?.effort ?? baselineEffort(primary), effortOptions = EFFORT_OPTIONS.some(option => option.value === effortValue) ? EFFORT_OPTIONS : [...EFFORT_OPTIONS, { value: effortValue, label: effortLabel(effortValue), disabled: true }];
 const vendor = edit?.vendor ?? baselineVendor(primary), modelLabel = kind === "review" ? "Review (code and security)" : "Model";
 return <div className="rv-hww-models">
  {stages.map(stage => { const result = stageResult(stage);return <div key={stage.stage} className="rv-hww-result" data-stage={stage.stage}>
   {stages.length > 1 && STAGE_NAMES[stage.stage] !== undefined && <p className="rv-muted">{STAGE_NAMES[stage.stage]}</p>}
   {result.kind === "effective" ? <>
    <p><span className="rv-hww-text"><VisibleText text={labelOf(modelKey(result.model))} /></span> <HowWeWorkMarker mark={{ source: result.decidedBy, locked: result.locked, ...(result.locked ? { lockedBy: "company" } : {}) }} /> <span className="rv-muted">Effort: {effortWords(result.thinkingLevel)}</span></p>
    <p className="rv-muted">{"Picked because: " + (isCheckingStage(stage.stage) ? checkingReasonLine(result.reason, result.noOtherCompany === true || result.otherCompanyFailed === true) : reasonLine(result.reason))}</p>
    {result.noOtherCompany === true && <p role="status"><VisibleText text={noOtherCompanyText(stage.stage, labelOf(modelKey(result.model)))} /></p>}
    {result.otherCompanyFailed === true && <p role="status"><VisibleText text={otherCompanyFailedText(stage.stage, labelOf(modelKey(result.model)))} /></p>}
   </> : result.kind === "refusal" ? <p role="status"><VisibleText text={refusalText(result.code)} />{result.fixHref !== undefined && <> <Link to={result.fixHref}>How to fix this</Link></>}</p> : <p className="rv-muted">{"notApplicable" in primary || !usesBaseSetting(stage.stage, primary.stage) || STAGE_NAMES[primary.stage] === undefined ? "This stage does not use a model." : "Uses the " + STAGE_NAMES[primary.stage] + " model."}</p>}
  </div>; })}
  {conflict !== undefined && conflict.projectChoice?.model !== undefined && <p>{"Your project's choice (" + labelOf(modelKey(conflict.projectChoice.model)) + ") isn't used while the company locks this stage."}</p>}
  {locked && <p>Locked by company. <Link to={lockHref}>Company How we work</Link></p>}
  {editable && <div className="rv-hww-pickers">
   <Select label={modelLabel} value={current} options={options} disabled={disabled} onValueChange={value => onChange({ model: value })} />
   {primary.candidatesState !== "complete" && <p className="rv-muted">The list of models isn't available right now.</p>}
   <Select label="Effort" value={effortValue} options={effortOptions} disabled={disabled} onValueChange={value => onChange({ effort: value as EffortValue })} />
   {reference !== undefined && <Switch label={"Different vendor than " + reference} checked={vendor} disabled={disabled} onCheckedChange={checked => onChange({ vendor: checked })} />}
  </div>}
  {!editable && !viewerOnly && !locked && !("notApplicable" in primary) && <p className="rv-muted">The model for this stage can't be changed here.</p>}
  {!editable && reference !== undefined && explicitVendor(primary) && <p className="rv-muted">{"Must be a different vendor than " + reference + "."}</p>}
  <p className="rv-muted">{COST_TEXT}</p>
 </div>;
}
