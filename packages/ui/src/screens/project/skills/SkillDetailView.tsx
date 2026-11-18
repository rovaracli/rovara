// One skill opened: the text of its newest version (what a person approves), where it stands, and the actions Code allows this person. A person approves the text they are reading: the approval names the version shown, and
// Code refuses it if the skill has changed since.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { SKILL_LOAD_FAILED, SKILL_RETIRE_CONFIRM, SKILL_STALE_WORDS, SKILL_WRITE_FAILED, approveHint, approvedWords, skillFailureWords, skillsKey, useSkill, useSkillsApi, waitingForApproval } from "../../../api/skills.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { SkillEditForm } from "./SkillEditForm.js";

type State = { kind: "idle" } | { kind: "editing" } | { kind: "confirming" } | { kind: "done"; text: string } | { kind: "error"; text: string };

export function SkillDetailView({ project, name, canDecide }: { project: string; name: string; canDecide: boolean }) {
  const read = useSkill(project, name), api = useSkillsApi(), query = useQueryClient(), announce = useAnnounce();
  const [state, setState] = useState<State>({ kind: "idle" }), [busy, setBusy] = useState(false);
  const refresh = () => { void query.invalidateQueries({ queryKey: skillsKey(project) }); };
  if (read.isPending) return <Skeleton label={`Loading ${name}`} />;
  if (read.isError || read.data === undefined) return <p role="alert" className="rv-skill-failed"><VisibleText text={read.error instanceof ApiError && read.error.status !== 502 ? read.error.message : SKILL_LOAD_FAILED} /></p>;
  const { skill } = read.data;
  // The buttons are Code's say-so (`canDecide`), asked again on the read of this one skill; Code still refuses anyone else.
  const may = canDecide && read.data.canDecide;
  async function run(write: () => Promise<string>) {
    setBusy(true);
    try { const text = await write();setState({ kind: "done", text });announce(`${name}: ${text}`);refresh(); }
    catch (failure) {
      const stale = failure instanceof ApiError && (failure.status === 404 || failure.status === 409 || failure.status === 412);
      setState({ kind: "error", text: skillFailureWords(failure, SKILL_WRITE_FAILED) });
      // Gone or changed by someone else: the skill is read again, and Code's own sentence stays on screen.
      if (stale) { announce(SKILL_STALE_WORDS);refresh(); }
    } finally { setBusy(false); }
  }
  return <div className="rv-skill-detail" data-testid={"skill-detail-" + name}>
    <pre className="rv-skill-text" tabIndex={0} aria-label={`Text of ${name}, version ${String(skill.currentVersion)}`} data-testid="skill-text"><VisibleText text={skill.content} /></pre>
    {waitingForApproval(skill) && <p data-testid="skill-approve-hint"><VisibleText text={approveHint(skill)} /></p>}
    {state.kind === "done" && <p role="status" className="rv-learned-note" data-testid="skill-done"><VisibleText text={state.text} /></p>}
    {state.kind === "editing" ? <SkillEditForm project={project} skill={skill} onCancel={() => setState({ kind: "idle" })} onSaved={text => { setState({ kind: "done", text });announce(`${name}: ${text}`);refresh(); }} />
      : state.kind === "confirming" ? <div className="rv-skill-detail-actions" role="group" aria-label={`Confirm retiring ${name}`}>
        <p>{SKILL_RETIRE_CONFIRM}</p>
        <Button variant="danger" busy={busy} onClick={() => { void run(async () => { await api.retire(project, name);return "Retired. Rovara no longer gives it to tasks."; }); }}>Retire skill</Button>
        <Button variant="quiet" disabled={busy} onClick={() => setState({ kind: "idle" })}>Cancel</Button></div>
        : may && !skill.retired && <div className="rv-skill-detail-actions">
          {waitingForApproval(skill) && !skill.approvedByYou && <Button variant="primary" busy={busy} aria-label={visibleText(`Approve version ${String(skill.currentVersion)} of ${name}`)} onClick={() => { void run(async () => approvedWords(await api.approve(project, name, skill.currentVersion))); }}>Approve this version</Button>}
          <Button disabled={busy} aria-label={visibleText(`Edit ${name}`)} onClick={() => setState({ kind: "editing" })}>Edit</Button>
          <Button variant="quiet" disabled={busy} aria-label={visibleText(`Retire ${name}`)} onClick={() => setState({ kind: "confirming" })}>Retire</Button></div>}
    {state.kind === "error" && <p role="alert" className="rv-skill-failed" data-testid="skill-error"><VisibleText text={state.text} /></p>}
  </div>;
}
