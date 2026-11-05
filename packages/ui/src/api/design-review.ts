// Design review (DR11): the calls behind the task page's "Design first" and "Skip" buttons, the choices on the cost card, and the design review setting of How we work.
// Wiring pending on the broker side (the controller adds the routes): `POST /v1/app/tasks/{taskId}/design-review/first`, `POST /v1/app/tasks/{taskId}/design-review/skip` and, already built,
// `POST /v1/app/tasks/{taskId}/design-review/spend/{choice}`. The setting uses the existing playbook routes (`GET` and `PUT /v1/app/projects/{p}/playbook`). Nothing here decides who may do what: the
// broker re-checks the caller on every press, and the page only shows what the task view's `designActions` said.
import { useMemo } from "react";
import { ProjectOverviewProjectSchema, ProjectPlaybookResponseReaderSchema, ProjectPlaybookResponseSchema, type DefaultProcess, type DesignReviewSetting, type ProjectPlaybookResponse } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";
import type { ReadDecision, ReadDecisionCard } from "./decisions.js";

const taskPath = (taskId: string): string => {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(taskId)) throw new ApiError(400, "CONFIG_INVALID", "This task can't be addressed.");
 return "/v1/app/tasks/" + taskId + "/design-review";
};
/** The choices of the cost card, by the last segment of their path: the same words the broker's card source writes (`DESIGN_SPEND_CHOICE_SEGMENTS`). */
export const SPEND_CHOICE_SEGMENTS = ["lower-tier", "raise-cap", "run-unpriced", "skip"] as const;
export type SpendChoiceSegment = (typeof SPEND_CHOICE_SEGMENTS)[number];

/** The card's own `choose` action, only when its address is exactly the spend route of the card's task. A client never follows an address a card made up. */
export function spendChoiceOf(card: ReadDecisionCard, action: ReadDecisionCard["actions"][number]): { path: string; choice: SpendChoiceSegment } | undefined {
 if (card.kind !== "approve_spend" || card.taskId === undefined || action.kind !== "choose" || action.method !== "POST") return undefined;
 const prefix = "/v1/app/tasks/" + card.taskId + "/design-review/spend/", choice = SPEND_CHOICE_SEGMENTS.find(segment => action.href === prefix + segment);
 return choice === undefined ? undefined : { path: action.href, choice };
}

/** The answer of a design review button is read loosely: the broker answers the task or the decision it changed, and the page reads the task again either way. */
/** The playbook answer, read exactly: the gateway's own fields are set aside, and a setting this version cannot read is refused rather than shown as something else. */
const exactPlaybook = { parse(value: unknown): ProjectPlaybookResponse {
 const read = ProjectPlaybookResponseReaderSchema.parse(value);
 return ProjectPlaybookResponseSchema.parse({ playbook: read.playbook, ...(read.designReviewLocked === undefined ? {} : { designReviewLocked: read.designReviewLocked }), ...(read.designReviewGroups === undefined ? {} : { designReviewGroups: read.designReviewGroups }), ...(read.designReviewAllowed === undefined ? {} : { designReviewAllowed: read.designReviewAllowed }), ...(read.designReviewUnreadable === undefined ? {} : { designReviewUnreadable: read.designReviewUnreadable }) });
} };
const AnyAnswer = { parse: (value: unknown): unknown => value };

export function createDesignReviewApi(host: AppHost) {
 const api = createApiClient(host), project = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name));
 return {
  /** "Design first": ask for the design to be reviewed before code. Works even when the project says never (owner Q3); the broker applies the company lock. */
  designFirst: (taskId: string, requestId: string): Promise<SendResult<unknown>> => api.send("POST", taskPath(taskId) + "/first", { requestId }, AnyAnswer, { retry: "never" }),
  /** "Skip design review": the broker works out again whether this person may (the project allows it, and only the design approver on a high-risk design). */
  skip: (taskId: string, requestId: string): Promise<SendResult<unknown>> => api.send("POST", taskPath(taskId) + "/skip", { requestId }, AnyAnswer, { retry: "never" }),
  /** "Retry review": the same design reviewed again after a review that did not run (`POST .../design-review/retry`). The broker applies the rule again and refuses what it no longer allows. */
  retry: (taskId: string, requestId: string): Promise<SendResult<unknown>> => api.send("POST", taskPath(taskId) + "/retry", { requestId }, AnyAnswer, { retry: "never" }),
  /** One choice on the cost card. `shownDigest` is what the person was shown: a changed card is refused as stale. */
  async chooseSpend(decision: ReadDecision, action: ReadDecisionCard["actions"][number], requestId: string): Promise<void> {
   const target = spendChoiceOf(decision.card, action);
   if (target === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   const result = await api.send("POST", target.path, { requestId, shownDigest: decision.digest }, AnyAnswer, { retry: "never" });
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This choice is waiting for confirmation. Open the decision to continue.");
  },
  /** The playbook with the design review setting the project RUNS with (held to the company lock) and the fields it cannot change. */
  playbook: (name: string): Promise<ProjectPlaybookResponse> => api.get(project(name) + "/playbook", exactPlaybook),
  /** Saves the design review setting under the revision the page read, with the default process unchanged. */
  async saveSetting(name: string, expectedRevision: number, defaultProcess: DefaultProcess, designReview: DesignReviewSetting): Promise<void> {
   const result = await api.send("PUT", project(name) + "/playbook", { expectedRevision, defaultProcess, designReview }, ProjectPlaybookResponseReaderSchema, { retry: "never" });
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change needs a second person to confirm it.");
  },
 };
}
export function useDesignReviewApi() { const host = useAppHost();return useMemo(() => createDesignReviewApi(host), [host]); }
export const designReviewKey = (project: string) => ["how-we-work", project, "design-review"] as const;
