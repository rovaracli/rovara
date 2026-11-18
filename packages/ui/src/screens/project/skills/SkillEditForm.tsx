// Edit a skill (L4-JA): the fields Code takes (a description, when to use it, 1 to 12 steps, and optionally when it is done and why), started from the form Code read back from the text when it could, else from nothing. Saving
// makes a NEW version with no approvals; the version in use stays in use until the new one has two different people's approval. The size is shown while the person writes (about: Code counts the real text and refuses one
// over 32 KB), with the "consider splitting" note over 8 KB. Nothing is saved but by the Save button, and every write is sent once.
import { useState } from "react";
import { SKILL_LIMITS, SKILL_LONG_NOTE, SKILL_WRITE_FAILED, estimateSkillBytes, savedWords, sizeWords, skillFailureWords, useSkillsApi, type SkillDetail } from "../../../api/skills.js";
import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";

export function SkillEditForm({ project, skill, onCancel, onSaved }: { project: string; skill: SkillDetail; onCancel: () => void; onSaved: (text: string) => void }) {
  const api = useSkillsApi();
  const start = skill.form;
  const [description, setDescription] = useState(start?.description ?? skill.description), [when, setWhen] = useState(start?.when ?? "");
  const [steps, setSteps] = useState<string[]>(start?.steps ?? [""]), [doneWhen, setDoneWhen] = useState(start?.doneWhen ?? ""), [why, setWhy] = useState(start?.why ?? "");
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState<string | undefined>(undefined);
  const filled = steps.map(step => step.trim()).filter(step => step !== "");
  const bytes = estimateSkillBytes(skill.name, { description, when, steps, doneWhen, why });
  const over = bytes > SKILL_LIMITS.textBytes, long = bytes > SKILL_LIMITS.longBytes;
  const ready = description.trim() !== "" && description.trim().length <= SKILL_LIMITS.description && when.trim() !== "" && filled.length >= 1 && filled.length === steps.length && !over && !busy;
  async function save() {
    setBusy(true);setFailed(undefined);
    try {
      const done = await api.edit(project, skill.name, { expectedVersion: skill.currentVersion, description: description.trim(), when: when.trim(), steps: filled, ...(doneWhen.trim() === "" ? {} : { doneWhen: doneWhen.trim() }), ...(why.trim() === "" ? {} : { why: why.trim() }) });
      onSaved(savedWords(done.version));
    } catch (failure) { setFailed(skillFailureWords(failure, SKILL_WRITE_FAILED));setBusy(false); }
  }
  const setStep = (index: number, value: string) => setSteps(steps.map((step, at) => (at === index ? value : step)));
  return <form className="rv-skill-form" aria-label={`Edit ${skill.name}`} onSubmit={event => { event.preventDefault();if (ready) void save(); }} data-testid="skill-edit-form">
    {start === undefined && <p className="rv-muted" data-testid="skill-edit-blank">Rovara can't show this skill's fields to start from, so write the new version in full. The text above is what is in use now.</p>}
    <TextField label="What it is for (one line)" value={description} maxLength={SKILL_LIMITS.description} onChange={event => setDescription(event.target.value)} />
    <TextArea label="When to use it" value={when} maxLength={SKILL_LIMITS.when} onChange={event => setWhen(event.target.value)} />
    <fieldset className="rv-skill-form">
      <legend>Steps (1 to {SKILL_LIMITS.steps})</legend>
      {steps.map((step, index) => <div className="rv-skill-step" key={index}>
        <TextArea label={`Step ${String(index + 1)}`} value={step} maxLength={SKILL_LIMITS.step} onChange={event => setStep(index, event.target.value)} />
        {steps.length > 1 && <Button variant="quiet" disabled={busy} aria-label={`Remove step ${String(index + 1)}`} onClick={() => setSteps(steps.filter((_, at) => at !== index))}>Remove</Button>}
      </div>)}
      <Button variant="quiet" disabled={busy || steps.length >= SKILL_LIMITS.steps} onClick={() => setSteps([...steps, ""])}>Add a step</Button>
    </fieldset>
    <TextArea label="How to know it is done (optional)" value={doneWhen} maxLength={SKILL_LIMITS.note} onChange={event => setDoneWhen(event.target.value)} />
    <TextArea label="Why this order (optional)" value={why} maxLength={SKILL_LIMITS.note} onChange={event => setWhy(event.target.value)} />
    <p className="rv-skill-size rv-muted" data-over={over} data-testid="skill-size">About <VisibleText text={sizeWords(bytes)} />.{over ? " Too long: a skill is at most 32 KB." : ""}</p>
    {long && !over && <p className="rv-muted" data-testid="skill-edit-long"><VisibleText text={SKILL_LONG_NOTE} /></p>}
    <p className="rv-muted">Saving makes a new version. It needs two different people to approve it before it is used.</p>
    <div className="rv-skill-detail-actions">
      <Button type="submit" variant="primary" busy={busy} disabled={!ready}>Save as a new version</Button>
      <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
    {failed !== undefined && <p role="alert" className="rv-skill-failed" data-testid="skill-edit-error"><VisibleText text={failed} /></p>}
  </form>;
}
