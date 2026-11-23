import { TalkQuestionRecoveryView } from "../session/TalkQuestionRecoveryView.js";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema, ProjectOverviewReaderSchema } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import type { AnswerAskBody, AnswerResponse } from "../../api/answers.js";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { createAnswersApi, useAnswersEnabled } from "../../api/answers.js";
import { AnswerBox } from "./AnswerBox.js";
import { A } from "./answer-text.js";
import { assertSessionIdentity, beginSessionRead, bindSessionRead, finishSessionRead, isCurrentSessionRead, sessionScope, useSessionIdentity } from "../../api/session-safety.js";
import { talkRead } from "../session/talk-lifecycle.js";

/**
 * "Ask about this task" on the session page (DEC 254z-amend2): the project's answers with task context only after Code serves its task-history read. The retained history is scoped to the current company, person and task. Drawn ONLY when this deployment's answers setting is on (the nav says so), which is turned
 * on only once the gateway's answers purpose is merged and deployed; otherwise nothing is drawn and no request is made. The old session Ask route is not used on hosted Cloud.
 */
export function TaskAnswers({ project, title, submitQuestion, pending, authorityLost = false, scope, taskId }: { project: string; title: string; taskId?: string | undefined; pending?: boolean | undefined; authorityLost?: boolean | undefined; scope?: string | undefined; submitQuestion?: ((body: AnswerAskBody) => Promise<AnswerResponse>) | undefined }) {
  const enabled = useAnswersEnabled(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
  const identity = useSessionIdentity(host, enabled && taskId !== undefined);
  const subject = "task-answers:" + project + ":" + taskId;
  const history = useQuery({
    queryKey: ["task-answer-history", identity.data?.companyId, identity.data?.personId, project, taskId],
    enabled: enabled && taskId !== undefined && identity.data !== undefined,
    retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always", structuralSharing: false,
    queryFn: async () => {
      const who = identity.data!;
      const fence = sessionScope(who, subject), issue = beginSessionRead(host, fence);
      try {
        let result;
        try { result = await createAnswersApi(host).history(project, taskId!); }
        catch (error) { if (error instanceof ApiError && error.status === 501 && error.code === "NOT_ON_CODE_YET") result = null;else throw error; }
        assertSessionIdentity(host, who);finishSessionRead(host, fence, issue);bindSessionRead(host, who, subject, result);
        return result;
      } catch (error) { finishSessionRead(host, fence, issue, error);throw error; }
    },
  });
  const overview = useQuery({ queryKey: ["project", project, "overview", identity.data?.companyId, identity.data?.personId], enabled, queryFn: () => talkRead(host, scope, "question-authority", () => api.get("/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/overview", ProjectOverviewReaderSchema)) });
  if (!enabled) return null;
  // Keep the native disclosure mounted while its contents wait for fresh reads.
  const content = () => {
    if (taskId !== undefined) {
      if (identity.isError || history.isError || history.failureCount > 0) {
        // Lost access (401/403) says so in the shared words; any other failed read keeps the generic check.
        const lost = [identity.error, history.error].some(error => error instanceof ApiError && [401, 403].includes(error.status));
        return <TalkQuestionRecoveryView read={lost ? "authority-lost" : "unavailable"} onCheck={() => { void identity.refetch();void history.refetch(); }} />;
      }
      if (!identity.isFetchedAfterMount || identity.data === undefined || (history.isFetching ? history.data === undefined : !isCurrentSessionRead(host, identity.data, subject, history.data))) return null;
    }
    if (overview.isError || overview.failureCount > 0) return <TalkQuestionRecoveryView read={overview.error instanceof ApiError && [401, 403].includes(overview.error.status) ? "authority-lost" : "unavailable"} onCheck={() => { void overview.refetch(); }} />;
    if (overview.data === undefined) return null;
    const context = ("Task: " + title).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300);
    return <AnswerBox key={taskId === undefined ? project : JSON.stringify([identity.data, project, taskId])} taskId={history.data === null ? undefined : taskId} past={history.isFetching ? undefined : history.data?.entries} historyMore={history.data?.more} onAnswered={() => { if (taskId !== undefined && history.data !== null) void history.refetch(); }} pending={pending || history.isFetching} authorityLost={authorityLost} presentation="talk" submitQuestion={submitQuestion} project={project} heading={A.ASK_TASK} repositories={overview.data.project.repositories} canStart={overview.data.you.canStartWork} context={context} />;
  };
  return <details className="rv-ask" data-testid="task-answers" open={pending || undefined}><summary>{A.ASK_TASK}</summary>{content()}</details>;
}
