import { useProject } from "../../api/projects.js";
import { useAnswersEnabled } from "../../api/answers.js";
import { AnswerBox } from "./AnswerBox.js";
import { A } from "./answer-text.js";

/**
 * "Ask about this task" on the session page (DEC 254z-amend2): the project's answers with the task's title as context. Drawn ONLY when this deployment's answers setting is on (the nav says so), which is turned
 * on only once the gateway's answers purpose is merged and deployed; otherwise nothing is drawn and no request is made. The old session Ask route is not used on hosted Cloud.
 */
export function TaskAnswers({ project, title }: { project: string; title: string }) {
  const enabled = useAnswersEnabled(), overview = useProject(enabled ? project : undefined);
  if (!enabled || overview.data === undefined) return null;
  const context = ("Task: " + title).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300);
  return <details className="rv-ask" data-testid="task-answers"><summary>{A.ASK_TASK}</summary><AnswerBox project={project} heading={A.ASK_TASK} repositories={overview.data.project.repositories} canStart={overview.data.you.canStartWork} context={context} /></details>;
}
