// The project's Skills tab (L4-JA, journey audit B11): the skills Rovara drafted from proven lessons, each with its versions, who has approved the newest one, its text, and (for the people Code says may decide) Edit, Approve and
// Retire. A version is used only after two DIFFERENT people approve it; the same person cannot approve twice. Everything is read from Code through Cloud (api/skills.ts) and Code decides every write. Words are fixed in api/skills.ts.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../../packages/ui/src/api/errors.js";
import { SKILLS_EMPTY, SKILLS_EMPTY_TITLE, SKILLS_INTRO, SKILLS_LOAD_FAILED, SKILLS_READ_ONLY, SKILLS_TITLE, approvalWords, skillStatus, skillsKey, useSkills, waitingForApproval, type SkillRow } from "../../../../packages/ui/src/api/skills.js";
import { Button } from "../../../../packages/ui/src/design/Button.js";
import { EmptyState } from "../../../../packages/ui/src/design/EmptyState.js";
import { Skeleton } from "../../../../packages/ui/src/design/Skeleton.js";
import { VisibleText } from "../../../../packages/ui/src/design/VisibleText.js";
import { SkillDetailView } from "./SkillDetailView.js";
import "../../../../packages/ui/src/screens/project/skills/skills.css";

function SkillItem({ project, skill, canDecide, open, toggle }: { project: string; skill: SkillRow; canDecide: boolean; open: boolean; toggle: () => void }) {
  const waiting = waitingForApproval(skill);
  return <li><article className="rv-skill" aria-labelledby={"skill-" + skill.name} data-skill={skill.name}>
    <header className="rv-skill-head">
      <h3 id={"skill-" + skill.name}><VisibleText text={skill.name} /></h3>
      <span className="rv-skill-status" data-testid={"skill-status-" + skill.name}>{skillStatus(skill)}</span>
    </header>
    <p className="rv-skill-description"><VisibleText text={skill.description} /></p>
    <ul className="rv-skill-facts">
      {waiting && <li data-testid={"skill-approvals-" + skill.name}>{approvalWords(skill)}</li>}
      {skill.note !== undefined && <li data-testid={"skill-note-" + skill.name}><VisibleText text={skill.note} /></li>}
    </ul>
    <div className="rv-skill-actions"><Button variant="quiet" aria-expanded={open} aria-label={(open ? "Close " : "Open ") + skill.name} onClick={toggle}>{open ? "Close" : "Open"}</Button></div>
    {open && <SkillDetailView project={project} name={skill.name} canDecide={canDecide} />}
  </article></li>;
}

export function SkillsTab({ project }: { project: string }) {
  const read = useSkills(project), query = useQueryClient();
  const [open, setOpen] = useState<string | undefined>(undefined);
  if (read.isPending) return <Skeleton label="Loading the skills" />;
  if (read.isError || read.data === undefined) {
    return <section className="rv-skills"><h2>{SKILLS_TITLE}</h2><p role="alert"><VisibleText text={read.error instanceof ApiError && read.error.status !== 502 ? read.error.message : SKILLS_LOAD_FAILED} /></p><Button onClick={() => { void query.invalidateQueries({ queryKey: skillsKey(project) }); }}>Try again</Button></section>;
  }
  const { skills, canDecide } = read.data;
  return <section className="rv-skills" aria-labelledby="skills-title" data-testid="skills-tab">
    <h2 id="skills-title">{SKILLS_TITLE}</h2>
    <p className="rv-muted">{SKILLS_INTRO}</p>
    {!canDecide && <p className="rv-muted" data-testid="skills-read-only">{SKILLS_READ_ONLY}</p>}
    {skills.length === 0 ? <EmptyState title={SKILLS_EMPTY_TITLE} description={SKILLS_EMPTY} testId="skills-empty" />
      : <ul className="rv-skill-list" aria-label="Skills">{skills.map(skill => <SkillItem key={skill.name} project={project} skill={skill} canDecide={canDecide} open={open === skill.name} toggle={() => setOpen(open === skill.name ? undefined : skill.name)} />)}</ul>}
  </section>;
}
