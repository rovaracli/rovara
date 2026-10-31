// K1 lane D, D2: what the end of a spec operation writes. A SPEC_WRITE run's result becomes rendered files (the broker's own rendering, checked against the approved plan's digest); a spec publication's result becomes the
// recorded spec pull request, checked against the pull request record the broker itself wrote when GitHub confirmed the branch. Either end also queues the code publication again, which the held state was waiting for.
import { PullRequestResultSchema, type SpecFile } from "@agentx/contracts";
import { acceptSpecWrite } from "./accept-draft.js";
import { specStateItem, type SpecStore, type TransactItem } from "./hooks.js";
import { publishSucceeded, stepFailed, writeSucceeded, type SpecFailureCode, type SpecState } from "./state.js";

export interface SpecOperationFacts {
  id: string;
  kind: string;
  workflowMode?: string | undefined;
  publication?: { spec?: boolean | undefined; repository: string; repositoryUrl: string; headBranch: string } | undefined;
}

export interface SpecEndEnvironment {
  tableName: string;
  store: SpecStore;
  now(): string;
  /** The digest of the plan that is approved now. */
  approvedPlanDigest(taskId: string): Promise<string | undefined>;
  taskKey(taskId: string): string;
  /** The team's template files at the state's `knowledgeCommit` (`team_template` only): meta-repo text read through the verified path; undefined where unreadable. */
  template(state: SpecState): Promise<readonly SpecFile[] | undefined>;
  /** The pull request record the broker wrote for this operation when it opened the spec pull request (nothing the worker reported). */
  pullRequestRecord(operation: SpecOperationFacts, number: number): Promise<{ url: string; expectedHeadCommit: string; createdByOperationId: string } | undefined>;
  /** The item that queues the held code publication again, or none when the task is no longer waiting at it. */
  republishItem(taskId: string): Promise<TransactItem | undefined>;
  /** The index item that lets a GitHub event on the spec pull request find its task. */
  specPullRequestIndexItem(taskId: string, pullRequest: { repositoryUrl: string; number: number; url: string }): TransactItem | undefined;
}

const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** The folder names a SPEC_WRITE run reported, or undefined when it reported none. Names that are not plain folder names are dropped; at most 500 are kept. */
function reportedFolders(result: unknown): string[] | undefined {
  const folders = result !== null && typeof result === "object" ? (result as { specContext?: { folders?: unknown } }).specContext?.folders : undefined;
  if (!Array.isArray(folders)) return undefined;
  return folders.filter((name): name is string => typeof name === "string" && FOLDER_NAME.test(name)).slice(0, 500);
}

export const isSpecOperation = (operation: SpecOperationFacts): boolean =>
  (operation.kind === "task" && operation.workflowMode === "SPEC_WRITE") || (operation.kind === "publish" && operation.publication?.spec === true);

/** The items to write when a spec operation ends. [] for an operation that is not the state's current one (a late or repeated end changes nothing). */
export async function specOperationEndItems(
  env: SpecEndEnvironment, taskId: string, operation: SpecOperationFacts, outcome: { status: string; result: unknown },
): Promise<TransactItem[]> {
  const { state } = await env.store.load(taskId);
  if (state === undefined) return [];
  const now = env.now();
  const fail = async (code: SpecFailureCode): Promise<TransactItem[]> => {
    const next = stepFailed(state, { operationId: operation.id, code }, now);
    return next === undefined ? [] : [specStateItem(env.tableName, next, state.revision)];
  };
  if (operation.kind === "task") {
    if (outcome.status !== "SUCCEEDED") return fail("write_failed");
    const approved = await env.approvedPlanDigest(taskId);
    if (approved === undefined) return fail("plan_changed");
    const needsTemplate = state.target.format === "team_template";
    const template = needsTemplate ? await env.template(state) : undefined;
    // The folder names the run read from the meta checkout (for `{n}`). A format that numbers its folders cannot be laid out without them.
    const folders = reportedFolders(outcome.result);
    if (folders === undefined && (state.target.pathTemplate ?? "").includes("{n}")) return fail("render_failed");
    if (folders === undefined && state.target.format === "speckit" && state.target.pathTemplate === undefined) return fail("render_failed");
    const accepted = acceptSpecWrite({ result: outcome.result, state, approvedPlanDigest: approved, taskKey: env.taskKey(taskId), existingFolders: folders ?? [], ...(template === undefined ? {} : { template }) });
    if (!accepted.ok) return fail(accepted.code);
    const next = writeSucceeded(state, { operationId: operation.id, title: accepted.title, files: accepted.files, requirementCount: accepted.requirementCount }, now);
    if (next === undefined) return [];
    const again = await env.republishItem(taskId);
    return [specStateItem(env.tableName, next, state.revision), ...(again === undefined ? [] : [again])];
  }
  // A spec publication.
  if (outcome.status !== "SUCCEEDED" || operation.publication === undefined) return fail("publish_failed");
  const published = PullRequestResultSchema.safeParse(outcome.result);
  if (!published.success || published.data.repository !== operation.publication.repository || published.data.headBranch !== operation.publication.headBranch) return fail("publish_failed");
  const record = await env.pullRequestRecord(operation, published.data.number);
  if (record === undefined || record.url !== published.data.url || record.expectedHeadCommit !== published.data.commit || record.createdByOperationId !== operation.id || !/^[a-f0-9]{40}$/u.test(published.data.commit)) return fail("publish_failed");
  const pullRequest = { number: published.data.number, url: record.url, repositoryUrl: operation.publication.repositoryUrl, headBranch: published.data.headBranch, commit: published.data.commit };
  const next = publishSucceeded(state, { operationId: operation.id, pullRequest }, now);
  if (next === undefined) return [];
  const index = env.specPullRequestIndexItem(taskId, pullRequest);
  const again = await env.republishItem(taskId);
  return [specStateItem(env.tableName, next, state.revision), ...(index === undefined ? [] : [index]), ...(again === undefined ? [] : [again])];
}
