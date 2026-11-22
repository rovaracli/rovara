import { TalkQuestionRecoveryView } from "../session/TalkQuestionRecoveryView.js";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema, ProjectOverviewReaderSchema } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import type { AnswerAskBody, AnswerResponse } from "../../api/answers.js";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { useAnswersEnabled } from "../../api/answers.js";
import { AnswerBox } from "./AnswerBox.js";
import { A } from "./answer-text.js";
import { talkRead } from "../session/talk-lifecycle.js";

/**
 * "Ask about this task" on the session page (DEC 254z-amend2): the project's answers with the task's title as context. Drawn ONLY when this deployment's answers setting is on (the nav says so), which is turned
 * on only once the gateway's answers purpose is merged and deployed; otherwise nothing is drawn and no request is made. The old session Ask route is not used on hosted Cloud.
 */
export function TaskAnswers({ project, title, submitQuestion, pending, authorityLost = false, scope }: { project: string; title: string; pending?: boolean | undefined; authorityLost?: boolean | undefined; scope?: string | undefined; submitQuestion?: ((body: AnswerAskBody) => Promise<AnswerResponse>) | undefined }) {
  const enabled = useAnswersEnabled(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
  const overview = useQuery({ queryKey: ["project", project, "overview"], enabled, queryFn: () => talkRead(host, scope, "question-authority", () => api.get("/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/overview", ProjectOverviewReaderSchema)) });
  if (!enabled) return null;
  if (overview.isError || overview.failureCount > 0) return <TalkQuestionRecoveryView read={overview.error instanceof ApiError && [401, 403].includes(overview.error.status) ? "authority-lost" : "unavailable"} onCheck={() => { void overview.refetch(); }} />;
  if (overview.data === undefined) return null;
  const context = ("Task: " + title).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300);
  return <details className="rv-ask" data-testid="task-answers"><summary>{A.ASK_TASK}</summary><AnswerBox pending={pending} authorityLost={authorityLost} presentation="talk" submitQuestion={submitQuestion} project={project} heading={A.ASK_TASK} repositories={overview.data.project.repositories} canStart={overview.data.you.canStartWork} context={context} /></details>;
}
