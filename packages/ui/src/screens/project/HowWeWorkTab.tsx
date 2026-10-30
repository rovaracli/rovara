import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBuilderApi } from "../../api/builder.js";
import { ApiError } from "../../api/errors.js";
import { howWeWorkKey, useHowWeWork, useHowWeWorkApi } from "../../api/how-we-work.js";
import { useStageModels } from "../../api/stage-models.js";
import { cardStages, editBaseStage, referenceKind } from "../../api/stage-cards.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "../agents/agent-context.js";
import { HowWeWorkCard, stageDomId } from "./HowWeWorkCard.js";
import { HowWeWorkHistory } from "./HowWeWorkHistory.js";
import { EDITABLE_KINDS, REVIEWING_KINDS, hasChanged, type Filter } from "./how-we-work-rows.js";
import { EMPTY_RULES, UNUSED_STAGE_ID, applyRuleEdits, ruleValues, type RuleEdits } from "./how-we-work-draft.js";
import type { Overlay } from "../builder/draft-state.js";
import { NewerRovaraCodeNotice } from "./NewerRovaraCodeNotice.js";
import { ReviewChangesDialog } from "./ReviewChangesDialog.js";
import { RuleField } from "./RuleField.js";
import { StageModelRows } from "./StageModelRows.js";
import { DRAFT_CHANGED_TEXT, EDITS_REMOVED_TEXT } from "./stage-model-text.js";
import { applicableStages, applyModelEdits, mergeEdit, pruneEdits, type ModelEdits, type StageEdit } from "./how-we-work-models.js";
import { cleanRuleText, ruleTooLong } from "./rule-text.js";
const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [{ value: "all", label: "All" }, { value: "changed", label: "Changed here" }, { value: "locked", label: "Locked" }];
const NOT_IN_USE = "This project runs Rovara Code's defaults.";
/** The draft moved on after the person chose a model: nothing is written. */
class DraftChanged extends Error {}
const LESS_SAFE_HINT = "Changing these instructions needs someone else who can approve changes in this project to confirm it.";
/** The "How we work" tab: Rovara Code's stages as cards of six marked rows. A maintainer edits the team's rules (project-wide and per stage) as a draft of the project's process layer, then reviews and publishes it. */
export function HowWeWorkTab({ project, canEdit }: { project: string; canEdit: boolean }) {
 const view = useHowWeWork(project), how = useHowWeWorkApi(), builder = useBuilderApi(), query = useQueryClient();
 const [filter, setFilter] = useState<Filter>("all"), [showUnchanged, setShowUnchanged] = useState(false), [edits, setEdits] = useState<{ rules?: string; stages: Record<string, string> }>({ stages: {} });
 const [ensured, setEnsured] = useState<string>(), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState<string>(), [saved, setSaved] = useState<"draft" | "removed" | false>(false);
 const [modelEdits, setModelEdits] = useState<ModelEdits>({}), [editRevision, setEditRevision] = useState<number>(), [discarded, setDiscarded] = useState(false), [removed, setRemoved] = useState(false);
 const [choosing, setChoosing] = useState(false), [chooseError, setChooseError] = useState<string>(), [reviewRequest, setReviewRequest] = useState(0);
 const data = view.data, layerId = data === undefined ? undefined : data.process.kind === "project_process" ? data.process.agentId : ensured ?? data.process.draftLayer?.agentId;
 const draftKey = [...howWeWorkKey(project), "draft", layerId] as const;
 const draft = useQuery({ queryKey: draftKey, enabled: canEdit && layerId !== undefined, queryFn: () => builder.draft(layerId!) });
 /** The stage models the cards show: the draft's when a maintainer is editing a layer (named by its revision), the published ones otherwise. If the read is not there, the cards keep their read-only model rows. */
 const draftRevision = canEdit && layerId !== undefined ? draft.data?.draft.revision : undefined, models = useStageModels(project, draftRevision, !canEdit || layerId === undefined || (draft.data !== undefined && draftRevision !== undefined));
 const baseline = useMemo(() => draft.data === undefined ? EMPTY_RULES : ruleValues(draft.data.draft.overlay as Overlay), [draft.data]);
 if (view.isPending) return <section aria-label="How we work"><Skeleton label="Loading how this project works" /></section>;
 if (view.isError || data === undefined) return <section aria-label="How we work"><p role="alert"><VisibleText text={failureText(view.error, "Couldn't load how this project works. Try again.")} /></p><Button onClick={() => { void view.refetch(); }}>Try again</Button></section>;
 /** Pending model edits only live as long as the read that allowed them: a draft that moved on, a stale-draft refusal, a lock, a stage that stopped being editable or a model that is no longer verified drops them (never written onto a newer revision). */
 const staleRead = models.error instanceof ApiError && (models.error.code === "DRAFT_STALE" || (models.error.code === "PLAYBOOK_STALE" && models.error.message.startsWith("DRAFT_STALE")));
 if (Object.keys(modelEdits).length > 0) {
  if (editRevision !== draftRevision || staleRead) { setModelEdits({});setDiscarded(true); }
  else {
   const kept = pruneEdits(modelEdits, id => { const ids = cardStages(data.stages.find(stage => stage.id === id)?.kind ?? "");return models.data === undefined || ids.length === 0 ? undefined : models.data.stages.filter(entry => ids.includes(entry.stage)); });
   if (kept !== modelEdits) { setModelEdits(kept);setRemoved(true); }
  }
 }
 const editableStages = data.stages.filter(stage => EDITABLE_KINDS.has(stage.kind));
 const rulesValue = edits.rules ?? baseline.rules, stageValue = (id: string) => edits.stages[id] ?? baseline.stages[id] ?? "";
 /** Only the texts the person changed; the rest of the draft is kept as it is. */
 const patch: RuleEdits = {};
 if (edits.rules !== undefined && cleanRuleText(edits.rules) !== baseline.rules) patch.rules = cleanRuleText(edits.rules);
 const changedStages = Object.entries(edits.stages).filter(([id, text]) => cleanRuleText(text) !== (baseline.stages[id] ?? ""));
 if (changedStages.length > 0) patch.stages = Object.fromEntries(changedStages.map(([id, text]) => [id, cleanRuleText(text)]));
 const dirty = patch.rules !== undefined || patch.stages !== undefined || Object.keys(modelEdits).length > 0, tooLong = [rulesValue, ...editableStages.map(stage => stageValue(stage.id))].some(ruleTooLong);
 /** The earlier step a checking card's "different vendor" toggle names: the Plan step for the plan check, the Build step for a review. */
 const referenceStage = (kind: string) => { const wanted = referenceKind(kind);return wanted === undefined ? undefined : data.stages.find(other => other.kind === wanted); };
 const references = Object.fromEntries(data.stages.map(stage => [stage.id, referenceStage(stage.kind)?.id]));
 const stageModelRows = (stage: (typeof data.stages)[number]) => {
  const ids = cardStages(stage.kind), found = models.data === undefined ? [] : ids.flatMap(id => models.data.stages.filter(entry => entry.stage === id));
  if (found.length === 0) return undefined;
  const reference = referenceStage(stage.kind);
  return <StageModelRows stages={found} kind={stage.kind} reference={reference === undefined ? undefined : reference.kind === "plan" ? "Plan" : "Build"} viewerOnly={!canEdit} edit={modelEdits[stage.id]} disabled={saving} onChange={(patch: StageEdit) => { setSaved(false);setDiscarded(false);setRemoved(false);setEditRevision(draftRevision);setModelEdits(current => mergeEdit(current, stage.id, patch, applicableStages(found).find(entry => entry.stage === editBaseStage(ids)) ?? applicableStages(found)[0] ?? found[0]!)); }} />;
 };
 const modelsProp = (stage: (typeof data.stages)[number]) => { const rows = stageModelRows(stage);return rows === undefined ? {} : { models: rows }; };
 const setStage = (id: string, text: string) => { setSaved(false);setEdits(current => ({ ...current, stages: { ...current.stages, [id]: text } })); };
 /** Make sure the layer exists, read its draft, write `changes` into it. */
 async function write(changes: RuleEdits, choices: ModelEdits = {}) {
  const layer = await how.ensureProcess(project), current = await builder.draft(layer.agentId);
  // Model choices were made against one draft revision; if someone else saved since, they are never written onto the newer draft.
  // With no layer at edit time (editRevision undefined) the layer was just created, so there is no earlier revision to have moved.
  if (Object.keys(choices).length > 0 && editRevision !== undefined && current.draft.revision !== editRevision) throw new DraftChanged();
  const next = await builder.save(layer.agentId, applyModelEdits(applyRuleEdits(current.draft.overlay as Overlay, changes), choices, references), current.draft.revision);
  query.setQueryData([...howWeWorkKey(project), "draft", layer.agentId], next);
  setEnsured(layer.agentId);
 }
 async function save() {
  if (!dirty || tooLong || saving) return;
  setSaving(true);setSaveError(undefined);setSaved(false);
  try {
   await write(patch, modelEdits);
   setEdits({ stages: {} });setModelEdits({});setDiscarded(false);setRemoved(false);setSaved("draft");
  } catch (failure) {
   if (failure instanceof DraftChanged) { setModelEdits({});setDiscarded(true);void draft.refetch();void models.refetch(); }
   else {
    setSaveError(failureText(failure, "Couldn't save the draft. Your edits are still here."));
    if (failure instanceof ApiError && failure.code === "AGENT_REVISION_CONFLICT") void draft.refetch();
   }
  } finally { setSaving(false); }
 }
 /** An old draft can hold rules on the pull request stage, which nothing uses and the server won't let a new publish add. Saves the draft without them (removal is allowed); other unsaved edits stay in their boxes. */
 async function removeUnusedStage() {
  if (saving) return;
  setSaving(true);setSaveError(undefined);setSaved(false);
  try { await write({ stages: { [UNUSED_STAGE_ID]: "" } });setSaved("removed"); }
  catch (failure) {
   setSaveError(failureText(failure, "Couldn't remove the rules. Try again."));
   if (failure instanceof ApiError && failure.code === "AGENT_REVISION_CONFLICT") void draft.refetch();
  } finally { setSaving(false); }
 }
 function refresh() { void query.invalidateQueries({ queryKey: howWeWorkKey(project) });if (layerId !== undefined) void query.invalidateQueries({ queryKey: ["agent", layerId] }); }
 /** A version of the layer the project does not run (it was set back to the built-in): shown as such, offered, and what a publish is compared with. */
 const savedVersion = data.process.kind === "builtin" ? data.process.draftLayer?.currentVersion : undefined;
 const published = data.process.kind === "project_process" ? data.process.version : savedVersion;
 /** "Use it": the saved version becomes the project's default, under the playbook revision this page read. */
 async function chooseSaved() {
  if (layerId === undefined || choosing) return;
  setChoosing(true);setChooseError(undefined);
  try { await how.useLayer(project, data!.playbookRevision, layerId);refresh(); }
  catch (failure) { setChooseError(failureText(failure, "Couldn't switch to the saved version. Try again.")); }
  finally { setChoosing(false); }
 }
 return <section className="rv-hww" aria-label="How we work">
  {data.process.update !== undefined && <NewerRovaraCodeNotice update={data.process.update} agentId={layerId} canEdit={canEdit} disabled={dirty || saving || draft.data === undefined} onMoved={async () => { await query.invalidateQueries({ queryKey: howWeWorkKey(project) });setReviewRequest(count => count + 1); }} />}
  <p className="rv-muted">How Rovara Code works in this project, stage by stage. Every setting says where it comes from.</p>
  {(staleRead || discarded) && <section className="rv-project-section" aria-label="Draft changed"><p role="alert">{DRAFT_CHANGED_TEXT}</p><Button onClick={() => { setDiscarded(false);void draft.refetch();void models.refetch(); }}>Reload</Button></section>}
  {removed && !staleRead && !discarded && <p role="status">{EDITS_REMOVED_TEXT}</p>}
  {savedVersion !== undefined && <section className="rv-project-section" aria-label="Saved version">
   <p>{NOT_IN_USE} A saved How we work version exists (version {savedVersion}).</p>
   {canEdit && <Button busy={choosing} onClick={() => { void chooseSaved(); }}>Use it</Button>}
   {chooseError !== undefined && <p role="alert"><VisibleText text={chooseError} /></p>}
  </section>}
  <ol className="rv-hww-stages" aria-label="Stages">{data.stages.map(stage => <li key={stage.id}><button type="button" className="rv-hww-stage" onClick={() => { const card = document.getElementById(stageDomId(stage.id) + "-title");card?.scrollIntoView({ block: "start" });card?.focus(); }}><VisibleText text={stage.name} />{hasChanged(stage, data) && <span className="rv-muted"> (changed here)</span>}</button></li>)}</ol>
  <div className="rv-hww-controls">
   <fieldset className="rv-hww-filter"><legend>Show</legend>{FILTERS.map(option => <label key={option.value}><input type="radio" name="hww-filter" value={option.value} checked={filter === option.value} onChange={() => setFilter(option.value)} /> {option.label}</label>)}</fieldset>
   <label><input type="checkbox" checked={showUnchanged} disabled={filter !== "all"} onChange={event => setShowUnchanged(event.target.checked)} /> Show unchanged settings</label>
  </div>
  {canEdit ? <section className="rv-hww-rules" aria-label="Project rules">
   <RuleField label="Project rules" hint="These apply to every stage that plans or builds. Reviewing stages only follow rules written for them." value={rulesValue} onChange={text => { setSaved(false);setEdits(current => ({ ...current, rules: text })); }} disabled={saving} />
  </section> : data.rules.length > 0 && <section className="rv-hww-rules" aria-label="Project rules"><h2>Project rules</h2><ul>{data.rules.map((rule, index) => <li key={index}><VisibleText text={rule.value} /></li>)}</ul></section>}
  <div className="rv-hww-cards">{data.stages.map(stage => <HowWeWorkCard key={stage.id} stage={stage} view={data} filter={filter} showUnchanged={showUnchanged} {...modelsProp(stage)} {...(canEdit && stage.id === UNUSED_STAGE_ID && (baseline.stages[stage.id] ?? "") !== "" ? { action: <Button busy={saving} aria-label="Remove rules from the pull request stage" onClick={() => { void removeUnusedStage(); }}>Remove</Button> } : {})} {...(canEdit && EDITABLE_KINDS.has(stage.kind) ? { editor: <RuleField label="Instructions for this stage" {...(REVIEWING_KINDS.has(stage.kind) ? { hint: LESS_SAFE_HINT } : {})} value={stageValue(stage.id)} onChange={text => setStage(stage.id, text)} disabled={saving} /> } : {})} />)}</div>
  {canEdit && <div className="rv-hww-actions">
   <Button variant="primary" busy={saving} disabled={!dirty || tooLong} onClick={() => { void save(); }}>Save draft</Button>
   <ReviewChangesDialog project={project} agentId={layerId ?? ""} from={published ?? "base"} revision={draft.data?.draft.revision ?? 0} disabled={layerId === undefined || draft.data === undefined || dirty} notInUse={savedVersion !== undefined} openRequest={reviewRequest} onPublished={refresh} />
   {dirty && <p className="rv-muted">You have edits that aren't saved. Save the draft to review them.</p>}
   {saved === "draft" && <p role="status">Draft saved. Review changes to publish it.</p>}
   {saved === "removed" && <p role="status">Removed the pull request stage rules from the draft. Review changes to publish it.</p>}
   {saveError !== undefined && <p role="alert"><VisibleText text={saveError} /></p>}
   {tooLong && <p role="alert">One of the texts is too long. Shorten it to save.</p>}
  </div>}
  {layerId !== undefined && (data.process.kind === "project_process" || savedVersion !== undefined) ? <HowWeWorkHistory project={project} agentId={layerId} canEdit={canEdit} inUse={data.process.kind === "project_process"} onChanged={refresh} /> : <section className="rv-project-section" aria-labelledby="hww-history"><h2 id="hww-history">History</h2><p className="rv-muted">No versions yet. Publish your first change to start the history.</p></section>}
 </section>;
}
