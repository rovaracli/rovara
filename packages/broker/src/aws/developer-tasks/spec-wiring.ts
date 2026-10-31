// Meta repo lane D (K1): the task side of the spec. Three entry points, each safe to call for any task: with no spec target nothing happens.
//   specAfterPlanApproval   -- a person approved the coding plan: record that a spec is due (nothing runs).
//   specPublicationGate     -- the code pull request is about to open: write and publish the spec first, hold while that runs or after it fails, add the spec link.
//   specOwnerChoice         -- the task owner's Retry / Continue without spec on a held spec.
// The pure parts (state, rendering, the link) are in ../../spec/; the effects here are the same ones the workflow already uses (a system-started run with its own conversation, the broker's publish).
import { createHash } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SPEC_REVIEW_REQUIREMENTS_MAX, SpecReviewInputSchema, agentXError, metaRepositoryOf, specStripHidden, workflowRequestId, type SpecFile, type SpecReviewInput, type WorkflowSnapshot } from "@agentx/contracts";
import { developerTaskIdentity, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional, workflowDispatchItem } from "../broker-shared.js";
import { createSpecHooks, type SpecTaskRef, type SpecWorld } from "../../spec/hooks.js";
import { approvedPlanDigestOf } from "../../spec/plan.js";
import { specPullRequestBody } from "../../spec/link.js";
import { specPullRequestTitle } from "../../spec/publish-request.js";
import { specTargetOf } from "../../spec/due.js";
import { specRendererFor } from "../../spec/index.js";
import { dynamoSpecStore } from "../../spec/store.js";
import type { SpecGate } from "../../spec/state.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { get, iso, taskPageUrl } from "./common.js";
import { accessFence, authorizeTaskAction, systemTaskAccess } from "./access.js";
import { approvedCodingPlan } from "./workflow-inputs.js";

const refOf = (task: DeveloperTaskRecord): SpecTaskRef => ({ taskId: task.taskId, title: task.title, knowledgeCommit: task.knowledgeCommit });

/** The run's own conversation, one for each task, so it never shares the planner's or the builder's session. */
function specConversationId(taskId: string): string {
  const hex = createHash("sha256").update(`agentx-spec-conversation:${taskId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function worldFor(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, metaName: string | undefined): SpecWorld {
  const store = dynamoSpecStore(deps);
  const log = (event: string, fields: Record<string, string | number | boolean>) => deps.log?.({ event, ...fields });
  return {
    tableName: deps.tableName, now: () => iso(deps), store, log,
    ...(deps.readSpecPullRequest === undefined ? {} : {
      readPullRequest: async (state) => state.specPullRequest === undefined ? undefined : deps.readSpecPullRequest!(task, state.specPullRequest.repositoryUrl, state.specPullRequest.number),
    }),
    startWrite: async ({ request, attemptKey, items }) => {
      const workspace = await deps.actions.workspace(task.workspaceId);
      if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "BUSY";
      const access = await systemTaskAccess(deps, task);
      const conversationId = specConversationId(task.taskId);
      const receivedAt = iso(deps);
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
        Item: { pk: `WORKSPACE#${task.workspaceId}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId: task.workspaceId, createdAt: receivedAt, updatedAt: receivedAt },
      })).catch((error: unknown) => { if (!isConditional(error)) throw error; });
      try {
        await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
          requestId: workflowRequestId("agentx-spec-write", task.taskId, Number(attemptKey)), conversationId, prompt: request.prompt,
        }, (operation) => [...items(operation.id), ...(access === undefined ? [] : [accessFence(deps, access)])],
        { sharedTask: task.shared === true, workflowMode: "SPEC_WRITE", specWrite: request.binding });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as { code?: string }).code === "WORKSPACE_BUSY") return "BUSY";
        throw error;
      }
      return "STARTED";
    },
    startPublish: async ({ state, attemptKey, items }) => {
      if (metaName === undefined || state.files === undefined) return "BUSY";
      const access = await systemTaskAccess(deps, task);
      try {
        await deps.actions.acceptPullRequest(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
          requestId: workflowRequestId("agentx-spec-publish", task.taskId, Number(attemptKey)), repository: metaName, title: specPullRequestTitle(task.title),
          body: specPullRequestBody({ taskTitle: task.title, requirementCount: state.requirementCount ?? 0, ...(deps.issuer === undefined ? {} : { taskPageUrl: taskPageUrl(deps.issuer, task.taskId) }) }), draft: false,
        }, (operation) => [...items(operation.id), ...(access === undefined ? [] : [accessFence(deps, access)])],
        { spec: { files: state.files, baseCommit: state.knowledgeCommit } });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as { code?: string }).code === "WORKSPACE_BUSY") return "BUSY";
        throw error;
      }
      return "STARTED";
    },
  };
}

async function pinnedDefinition(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord) {
  if (task.startingRevision === undefined) return undefined;
  return (await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision))?.definition;
}

/** A person approved the coding plan. Records that a spec is due when the project's target says so. Never throws and never blocks the approval: a failure here is logged, and the code pull request's gate finds no state and goes on as before. */
export async function specAfterPlanApproval(deps: DeveloperTaskRouteDependencies, taskId: string): Promise<void> {
  try {
    const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
    const definition = task === undefined ? undefined : await pinnedDefinition(deps, task);
    const target = definition === undefined ? undefined : specTargetOf(definition);
    if (task === undefined || target === undefined) return;
    const planDigest = approvedPlanDigestOf(task);
    if (planDigest === undefined) return;
    const metaName = definition === undefined ? undefined : metaRepositoryOf(definition)?.name;
    await createSpecHooks(worldFor(deps, task, metaName)).onPlanApproved({ task: refOf(task), planDigest, kind: "feature", target });
  } catch (error) {
    deps.log?.({ event: "spec.record_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

export type SpecPublicationGateResult = { proceed: true; linkLine?: string } | { proceed: false; hold: Extract<SpecGate, { action: "hold" }> };

/**
 * Called before a code pull request opens. A task with no spec state proceeds at once (one read). Otherwise: the next step is started and the code pull request waits ("hold"), or the spec's link is
 * returned for the description. Any failure here is a hold, never a proceed: a project that asked for a spec does not get code pull requests without it unless the owner says so.
 */
export async function specPublicationGate(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<SpecPublicationGateResult> {
  try {
    const { state, corrupt } = await dynamoSpecStore(deps).load(task.taskId);
    if (state === undefined && !corrupt) return { proceed: true };
    const definition = await pinnedDefinition(deps, task);
    const meta = definition === undefined ? undefined : metaRepositoryOf(definition);
    const plan = await approvedPlanForSpec(deps, workflow);
    return await createSpecHooks(worldFor(deps, task, meta?.name)).gate({
      task: refOf(task), approvedPlanDigest: plan?.sha256 ?? "", planMarkdown: () => plan?.text, metaRepositoryUrl: meta?.url,
    });
  } catch (error) {
    deps.log?.({ event: "spec.gate_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return { proceed: false, hold: { action: "hold", reason: "failed", message: "The spec could not be checked just now.", ownerActions: ["continue_without_spec"] } };
  }
}

/** The plan the spec is written from: the approved coding plan exactly as the builder and the reviewers are given it. Undefined where it cannot be read (the gate then holds; it never guesses). */
async function approvedPlanForSpec(deps: DeveloperTaskRouteDependencies, workflow: WorkflowSnapshot): Promise<{ text: string; sha256: string } | undefined> {
  try {
    const approved = await approvedCodingPlan(deps, workflow);
    return { text: approved.text, sha256: approved.sha256 };
  } catch {
    return undefined;
  }
}

/** The folder common to a spec's files, with a trailing slash. */
function commonFolder(paths: readonly string[]): string {
  const folders = paths.map((path) => path.split("/").slice(0, -1));
  const first = folders[0] ?? [];
  let length = first.length;
  for (const folder of folders) { let same = 0; while (same < length && folder[same] === first[same]) same += 1; length = same; }
  return first.slice(0, length).join("/") === "" ? "" : `${first.slice(0, length).join("/")}/`;
}

const SPEC_FILE_READ_MAX_BYTES = 64 * 1024;

export type SpecReviewGateResult = { proceed: true; input?: SpecReviewInput } | { proceed: false; hold: Extract<SpecGate, { action: "hold" }> };

/**
 * Called before the code review starts. With no spec state it does nothing. Otherwise the spec is written and published first (a project that asked for a spec has its code reviewed against it), and the
 * review is given the requirements as the spec shows them at the commit recorded when it was published: read by the broker from the meta repository, never from the builder's workspace. Anything that
 * cannot be read is a hold; a review without its spec is never started by accident.
 */
export async function specReviewGate(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<SpecReviewGateResult> {
  const hold = (message: string): SpecReviewGateResult => ({ proceed: false, hold: { action: "hold", reason: "failed", message, ownerActions: ["continue_without_spec"] } });
  try {
    const { state, corrupt } = await dynamoSpecStore(deps).load(task.taskId);
    if (state === undefined && !corrupt) return { proceed: true };
    const definition = await pinnedDefinition(deps, task);
    const meta = definition === undefined ? undefined : metaRepositoryOf(definition);
    const plan = await approvedPlanForSpec(deps, workflow);
    const gate = await createSpecHooks(worldFor(deps, task, meta?.name)).gate({
      task: refOf(task), approvedPlanDigest: plan?.sha256 ?? "", planMarkdown: () => plan?.text, metaRepositoryUrl: meta?.url, purpose: "review",
    });
    if (!gate.proceed) return gate;
    // Continued without the spec (or never due): nothing to walk.
    const published = (await dynamoSpecStore(deps).load(task.taskId)).state;
    if (published === undefined || published.continuedWithoutSpec !== undefined || published.status === "skipped") return { proceed: true };
    if (published.specPullRequest === undefined || published.files === undefined || meta === undefined || deps.readMetaFile === undefined) return hold("The spec could not be read for the review.");
    const renderer = specRendererFor(published.target.format);
    if (renderer === undefined) return hold("The spec's format is not one Rovara has.");
    const commit = published.specPullRequest.commit;
    const read: SpecFile[] = [];
    for (const file of published.files) {
      const text = await deps.readMetaFile(task, meta.url, file.path, commit, SPEC_FILE_READ_MAX_BYTES);
      if (text === undefined) return hold("The spec could not be read at its recorded commit.");
      read.push({ path: file.path, content: specStripHidden(text) });
    }
    const found = renderer.extractRequirements(read).filter((entry) => entry.kind === "requirement");
    // A spec with nothing left to check (everything deleted from the spec pull request) is the owner's call, not something the review quietly skips.
    if (found.length === 0) return hold("The spec at its recorded commit lists no requirements.");
    const requirements = found.slice(0, SPEC_REVIEW_REQUIREMENTS_MAX).map((entry) => ({ ...entry, kind: "requirement" as const }));
    // Two files can number a requirement alike; the review answers by label, so a repeated label is dropped after its first.
    const unique = requirements.filter((entry, index) => requirements.findIndex((other) => other.id === entry.id) === index);
    const input = SpecReviewInputSchema.safeParse({ specPath: commonFolder(published.files.map((file) => file.path)) || published.files[0]!.path, specCommit: commit, requirements: unique, truncated: found.length > SPEC_REVIEW_REQUIREMENTS_MAX });
    return input.success ? { proceed: true, input: input.data } : hold("The spec could not be read for the review.");
  } catch (error) {
    deps.log?.({ event: "spec.review_gate_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return hold("The spec could not be checked just now.");
  }
}

/** Queues the code publication again after an owner's choice. Overwrites a row that is still waiting. */
async function queueRepublish(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<void> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.candidate === undefined) return;
  const kind = workflow.stage === "REVIEW" && workflow.state === "WAITING" ? "REVIEW" as const : workflow.stage === "PULL_REQUEST" && workflow.state === "READY" ? "PUBLISH" as const : undefined;
  if (kind === undefined) return;
  const row = workflowDispatchItem(deps.tableName, task.taskId, workflow.revision, kind, workflow.candidate.digest, iso(deps));
  if (row.Put !== undefined) await deps.documentClient.send(new PutCommand({ TableName: row.Put.TableName, Item: row.Put.Item }));
}

/** The task owner's choice on a held spec. Only the owner's own authority to publish counts (the same as pressing Retry on a publication). */
export async function specOwnerChoice(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, action: "retry" | "continue_without_spec" | "keep" | "replan"): Promise<{ status: string }> {
  const access = await authorizeTaskAction(deps, caller, taskId, "publish");
  const task = access.task;
  const definition = await pinnedDefinition(deps, task);
  const hooks = createSpecHooks(worldFor(deps, task, definition === undefined ? undefined : metaRepositoryOf(definition)?.name));
  const next = await hooks.ownerChoice({ taskId, action, by: caller.developerId });
  if (next === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "this choice is out of date; refresh the task and try again");
  await queueRepublish(deps, task);
  return { status: next.status };
}

