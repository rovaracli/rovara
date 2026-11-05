import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DESIGN_REVIEW_APPROVERS_MAX, designReviewSettingOf } from "@agentx/contracts/web";
import { designReviewKey, useDesignReviewApi } from "../../api/design-review.js";
import { howWeWorkKey } from "../../api/how-we-work.js";
import { useOnboardingApi } from "../../api/onboarding.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Card } from "../../design/Card.js";
import { Checkbox } from "../../design/Checkbox.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Switch } from "../../design/Switch.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "../agents/agent-context.js";
import { HowWeWorkMarker } from "./HowWeWorkMarker.js";
import { APPROVER_WORDS, LOCK_REASON, MODE_OPTIONS, TIER_OPTIONS, approverKinds, designRows, draftOf, lockedSet, sameSetting, settingLines, settingOf, type ApproverKind, type SettingDraft } from "./design-review-setting.js";
import type { Filter } from "./how-we-work-rows.js";

const PLAYBOOK_STALE = "Someone changed how this project works. Reload and try again.";

/**
 * The "Design review" stage card of How we work, with the settings editor for a maintainer. It reads the setting the project RUNS with (the playbook answer, held to the company lock) and saves it through the
 * playbook PUT's `designReview` field. A field the company locks is read-only and says why. "A group" is offered only where the broker says groups exist (Enterprise).
 */
export function DesignReviewCard({ project, canEdit, filter }: { project: string; canEdit: boolean; filter: Filter }) {
 const api = useDesignReviewApi(), onboarding = useOnboardingApi(), query = useQueryClient();
 const playbook = useQuery({ queryKey: designReviewKey(project), queryFn: () => api.playbook(project) });
 const members = useQuery({ queryKey: [...designReviewKey(project), "members"], enabled: canEdit, queryFn: () => onboarding.members(), retry: false });
 const [draft, setDraft] = useState<SettingDraft>(), [saving, setSaving] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 const id = "hww-stage-design-review";
 if (playbook.isPending) return <Card className="rv-hww-card" aria-label="Design review" id={id}><Skeleton label="Loading the design review setting" /></Card>;
 // A server that has no playbook route for this project shows no card; any other failure is said plainly (a note, not an alert: the rest of the page is fine) with a way to read it again.
 if (playbook.error instanceof ApiError && playbook.error.status === 404) return null;
 // The broker answers 200 with no `designReview` where the stage is off (and always sends it where the company allows design review): no card there. A company that has not allowed it is said below (DR-FU4).
 if (playbook.data !== undefined && playbook.data.playbook.designReview === undefined && playbook.data.designReviewAllowed !== false) return null;
 if (playbook.isError || playbook.data === undefined) return <Card className="rv-hww-card" aria-labelledby={id + "-title"} id={id}><h3 id={id + "-title"} tabIndex={-1}>Design review</h3><p role="status"><VisibleText text={failureText(playbook.error, "Couldn't load the design review setting.")} /></p><Button onClick={() => { void playbook.refetch(); }}>Reload design review settings</Button></Card>;
 // The company has not allowed design review (DR-FU4): no setting is shown or editable, and the card says why in plain words. The server decides; this only reflects it.
 if (playbook.data.designReviewAllowed === false) return <Card className="rv-hww-card" aria-labelledby={id + "-title"} id={id}><h3 id={id + "-title"} tabIndex={-1}>Design review</h3><p className="rv-muted">Before Rovara builds, reviewers that never saw the conversation read the design and raise what it assumes or gets wrong. A person approves the design.</p><p role="status">Design review is not turned on for your company, so it does not run in this project. A company owner or admin can allow it in How we work for the company.</p></Card>;
 const response = playbook.data, setting = designReviewSettingOf(response.playbook), locked = lockedSet(response.designReviewLocked), groups = response.designReviewGroups === true;
 const names = new Map((members.data?.members ?? []).map(member => [member.developerId, member.name]));
 const nameOf = (person: string) => names.get(person);
 const rows = designRows(setting, locked, nameOf), lines = settingLines(setting, locked, response.designReviewUnreadable === true ? { canEdit } : undefined), editing = draft !== undefined;
 const shownRows = filter === "locked" ? rows.filter(row => row.values.some(value => value.mark.locked)) : filter === "changed" ? rows.filter(row => row.values.some(value => value.mark.source === "project")) : rows;
 const current = draft ?? draftOf(setting), anyLocked = locked.size > 0;
 const patch = (change: Partial<SettingDraft>) => { setSaved(false);setError(undefined);setDraft({ ...current, ...change }); };
 const result = settingOf(current, groups), changed = editing && result.ok && !sameSetting(result.setting, setting), problems = editing && !result.ok ? result.problems : {};
 async function save() {
  if (saving || !result.ok) return;
  setSaving(true);setError(undefined);setSaved(false);
  try {
   await api.saveSetting(project, response.playbook.revision, response.playbook.defaultProcess, result.setting);
   setDraft(undefined);setSaved(true);
   await Promise.all([playbook.refetch(), query.invalidateQueries({ queryKey: howWeWorkKey(project) })]);
  } catch (failure) {
   setError(failure instanceof ApiError && failure.code === "PLAYBOOK_STALE" ? PLAYBOOK_STALE : failureText(failure, "Couldn't save the design review setting. Your edits are still here."));
   if (failure instanceof ApiError && failure.code === "PLAYBOOK_STALE") void playbook.refetch();
  } finally { setSaving(false); }
 }
 const lockNote = (field: "tier" | "allowSkip" | "capUsdPerTask" | "highRiskApprover") => locked.has(field) ? <p className="rv-muted" id={"design-lock-" + field}>{LOCK_REASON}</p> : null;
 const kinds = approverKinds(groups), kindOptions = (kinds.includes(current.approverKind) ? kinds : [...kinds, current.approverKind]).map(value => ({ value, label: APPROVER_WORDS[value] + (value === "group" && !groups ? " (not available here)" : ""), disabled: value === "group" && !groups }));
 const people = members.data?.members ?? [];
 return <Card className="rv-hww-card rv-hww-design" aria-labelledby={id + "-title"} id={id}>
  <h3 id={id + "-title"} tabIndex={-1}>Design review</h3>
  <p className="rv-muted">Before Rovara builds, reviewers that never saw the conversation read the design and raise what it assumes or gets wrong. A person approves the design.</p>
  {anyLocked && <p className="rv-hww-note" role="status">{locked.size === 4 ? "Your company controls every design review setting here." : "Your company locks some of these settings. Locked settings are read-only."}</p>}
  {shownRows.length === 0 ? <p className="rv-muted">Nothing here is changed or locked. Show all settings to see everything.</p> : <dl className="rv-hww-rows">{shownRows.map(row => <div className="rv-hww-row" key={row.id}>
   <dt>{row.title}</dt>
   <dd><ul>{row.values.map((value, index) => <li key={index} className={value.block ? "rv-hww-block" : undefined}><span className="rv-hww-text"><VisibleText text={value.text} /></span> <HowWeWorkMarker mark={value.mark} /></li>)}</ul></dd>
  </div>)}</dl>}
  {(filter === "all" || filter === "locked" || filter === "changed") && <dl className="rv-hww-rows" aria-label="Design review settings">{lines.filter(line => filter === "all" || (filter === "locked" ? line.mark.locked : line.mark.source === "project")).map(line => <div className="rv-hww-row" key={line.field}>
   <dt>{line.label}</dt><dd><span className="rv-hww-text">{line.text}</span> <HowWeWorkMarker mark={line.mark} /></dd>
  </div>)}</dl>}
  {canEdit && <section className="rv-design-setting" aria-label="Design review settings editor">
   <h4>Change these settings</h4>
   <div className="rv-design-field"><Select label="When it runs" value={current.mode} options={MODE_OPTIONS} disabled={saving} onValueChange={value => patch({ mode: value as SettingDraft["mode"] })} /></div>
   <div className="rv-design-field"><Select label="Tier" value={current.tier} options={TIER_OPTIONS} disabled={locked.has("tier") || saving} onValueChange={value => patch({ tier: value as SettingDraft["tier"] })} />{lockNote("tier")}</div>
   <div className="rv-design-field"><Switch label="Allow skipping design review" checked={current.allowSkip} disabled={locked.has("allowSkip") || saving} onCheckedChange={value => patch({ allowSkip: value })} />{lockNote("allowSkip")}</div>
   <div className="rv-design-field"><TextField label="Cost limit per task (USD)" type="number" inputMode="decimal" min={0.5} max={100} step={0.5} value={current.capText} disabled={locked.has("capUsdPerTask") || saving} hint="Between $0.50 and $100. Above it, a person decides." {...(problems.cap === undefined ? {} : { error: problems.cap })} onChange={event => patch({ capText: event.target.value })} />{lockNote("capUsdPerTask")}</div>
   <div className="rv-design-field"><Select label="Who approves a high-risk design" value={current.approverKind} options={kindOptions} disabled={locked.has("highRiskApprover") || saving} onValueChange={value => patch({ approverKind: value as ApproverKind })} />{lockNote("highRiskApprover")}
    {current.approverKind === "people" && <fieldset className="rv-design-people" disabled={locked.has("highRiskApprover") || saving}><legend>Named people (up to {DESIGN_REVIEW_APPROVERS_MAX})</legend>
     {members.isError ? <p className="rv-muted">The list of people can't be loaded right now. People already named stay named.</p> : people.map(person => <Checkbox key={person.developerId} label={person.name} checked={current.memberIds.includes(person.developerId)} disabled={locked.has("highRiskApprover") || saving} onCheckedChange={value => patch({ memberIds: value === true ? [...current.memberIds, person.developerId] : current.memberIds.filter(other => other !== person.developerId) })} />)}
     {problems.people !== undefined && <p role="alert">{problems.people}</p>}</fieldset>}
    {current.approverKind === "group" && <TextField label="Group" value={current.groupId} disabled={locked.has("highRiskApprover") || saving || !groups} {...(problems.group === undefined ? {} : { error: problems.group })} onChange={event => patch({ groupId: event.target.value })} />}
   </div>
   <div className="rv-hww-actions">
    <Button variant="primary" busy={saving} disabled={!changed || locked.size === 4} onClick={() => { void save(); }}>Save design review settings</Button>
    {editing && <Button disabled={saving} onClick={() => { setDraft(undefined);setError(undefined); }}>Discard</Button>}
   </div>
   {saved && <p role="status">Saved. New design reviews use these settings; running ones keep theirs.</p>}
   {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  </section>}
 </Card>;
}
