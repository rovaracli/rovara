// LEGACY (test-only): the Skills tab's old one-skill view. Production draws the rebuilt Skills pages (screens/wiki-skills-read) and shares only SkillActions.
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../../packages/ui/src/api/errors.js";
import { SKILL_LOAD_FAILED, skillsKey, useSkill } from "../../../../packages/ui/src/api/skills.js";
import { Skeleton } from "../../../../packages/ui/src/design/Skeleton.js";
import { VisibleText } from "../../../../packages/ui/src/design/VisibleText.js";
import { SkillActions } from "../../../../packages/ui/src/screens/project/skills/SkillActions.js";

export function SkillDetailView({ project, name, canDecide }: { project: string; name: string; canDecide: boolean }) {
  const read = useSkill(project, name), query = useQueryClient();
  const refresh = () => { void query.invalidateQueries({ queryKey: skillsKey(project) }); };
  if (read.isPending) return <Skeleton label={`Loading ${name}`} />;
  if (read.isError || read.data === undefined) return <p role="alert" className="rv-skill-failed"><VisibleText text={read.error instanceof ApiError && read.error.status !== 502 ? read.error.message : SKILL_LOAD_FAILED} /></p>;
  const { skill } = read.data;
  return <div className="rv-skill-detail" data-testid={"skill-detail-" + name}>
    <pre className="rv-skill-text" tabIndex={0} aria-label={`Text of ${name}, version ${String(skill.currentVersion)}`} data-testid="skill-text"><VisibleText text={skill.content} /></pre>
    <SkillActions project={project} skill={skill} may={canDecide && read.data.canDecide} refresh={refresh} />
  </div>;
}
