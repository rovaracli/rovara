// Meta repo lane D (K1): what the broker's operation end needs to settle a spec write or a spec publication. The pure parts are in ../../spec/; this module reads the broker's own records for them.
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { workflowDispatchItem } from "../broker-shared.js";
import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { metaRepositoryOf, type SpecFile } from "@agentx/contracts";
import { approvedPlanDigestOf } from "../../spec/plan.js";
import { refreshSpecState, type SpecPullRequestFacts } from "../../spec/refresh.js";
import { specPullRequestKey, type SpecState } from "../../spec/state.js";
import { githubSpecClient } from "../../spec/github-git-client.js";
import { SpecPublishError, classifyPublishError, publishSpec } from "../../spec/publish.js";
import { specPullRequestBody } from "../../spec/link.js";
import { designSpecStateOf, specDesignLineOf } from "../developer-tasks/design-spec.js";
import { readObjectText } from "../../developer/plan-artifacts.js";
import { projectForbiddenFolders, specPullRequestTitle } from "../../spec/publish-request.js";
import type { SpecPublishOutcome } from "../../spec/hooks.js";
import { dynamoSpecStore } from "../../spec/store.js";
import type { SpecEndEnvironment } from "../../spec/end-items.js";
import { getItem } from "../cancellation.js";
import { githubRepositoryFullName } from "./admin-and-helpers.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { taskPageUrl } from "../developer-tasks/common.js";
import { githubScopeOf } from "./scope-helpers.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { approvalReviewsOf } from "../../rovara-code/host-port.js";
import { changeRequestRef, hostOfRepository, hostOfTaskRepository } from "./repository-hosts.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** A GitHub client for the task's project's meta repository, with a token the broker minted for itself (the same grant a worker would exchange, issued and exchanged here, never sent anywhere). */
async function metaClient(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, access: "clone" | "push") {
  if (task.startingRevision === undefined) throw new SpecPublishError("setup", false);
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  const meta = metaRepositoryOf(project.definition);
  if (meta === undefined) throw new SpecPublishError("setup", false);
  // P5d: the meta repository's code host, by its record (an unknown kind is refused with the router's fixed sentence). The spec client below speaks GitHub's git API, so a meta repository on
  // another host cannot publish a spec yet: that is a permanent refusal, not a retry (left for P6).
  const host = hostOfRepository(dependencies, meta);
  if (host.kind !== GITHUB_HOST_KIND) throw new SpecPublishError("setup", false);
  const operationId = randomUUID();
  const scope = await githubScopeOf(dependencies, task);
  const grant = dependencies.repositoryGrants.issue({
    ownerKey: task.ownerKey, projectName: project.definition.name, workspaceId: task.workspaceId, operationId, ttlSeconds: 120,
    repositories: [{ credentialRef: meta.credentialRef, repositoryUrl: meta.url, access, hostKind: host.kind }],
  });
  const credential = await dependencies.repositoryGrants.exchange(grant, { workspaceId: task.workspaceId, operationId, credentialRef: meta.credentialRef, repositoryUrl: meta.url, access }, scope);
  const token = credential.token ?? credential.password;
  if (token === undefined || token === "") throw new SpecPublishError("setup", false);
  const parsed = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(meta.url);
  if (parsed === null) throw new SpecPublishError("setup", false);
  return { meta, scope, host, client: githubSpecClient({ repository: { owner: parsed[1]!, name: parsed[2]! }, token }) };
}

export function specEndEnvironmentOf(dependencies: AwsBrokerDependencies, now: () => string = () => new Date().toISOString()): SpecEndEnvironment {
  const taskIdToTask = async (taskId: string) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  // The task `approvedPlanDigest` just read, kept for the `design` port that runs right after it in the same spec end: the design step adds NO read of its own, so a spec write with design review off has exactly the reads it
  // had before (a transient read error cannot fail it). The entry is used once and then dropped.
  let justRead: { taskId: string; task: DeveloperTaskRecord | undefined } | undefined;
  return {
    tableName: dependencies.tableName,
    store: dynamoSpecStore(dependencies),
    now,
    approvedPlanDigest: async (taskId) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
      justRead = { taskId, task };
      return approvedPlanDigestOf(task);
    },
    // Design review (DR12): the spec waits for the approved design and writes it with the spec. Off for a task with no design review. It reads the task `approvedPlanDigest` read, not the table again.
    design: async (taskId) => {
      const earlier = justRead?.taskId === taskId ? justRead : undefined;
      justRead = undefined;
      const task = earlier !== undefined ? earlier.task : await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
      return designSpecStateOf(task, async (key, max) => (await readObjectText(dependencies.s3, dependencies.artifactBucketName, key, max)) ?? "");
    },
    taskKey: (taskId) => taskId.slice(0, 8),
    // Both are read by the broker through GitHub at the task's knowledgeCommit, never from the workspace the builder wrote.
    existingFolders: async (state, parent) => {
      try {
        const task = await taskIdToTask(state.taskId);
        if (task === undefined) return undefined;
        const { client } = await metaClient(dependencies, task, "clone");
        const listed = await client.listDirectory(parent, state.knowledgeCommit);
        return listed === undefined ? [] : listed.filter((entry) => entry.type === "dir").map((entry) => entry.name).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name)).slice(0, 500);
      } catch { return undefined; }
    },
    template: async (state) => {
      try {
        const task = await taskIdToTask(state.taskId);
        const folder = state.target.templatePath;
        if (task === undefined || folder === undefined) return undefined;
        const { client } = await metaClient(dependencies, task, "clone");
        const listed = await client.listDirectory(folder, state.knowledgeCommit);
        if (listed === undefined) return undefined;
        const files: SpecFile[] = [];
        for (const entry of listed.filter((item) => item.type === "file" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:md|markdown|txt)$/iu.test(item.name)).slice(0, 12)) {
          const text = await client.readFile(`${folder.replace(/\/+$/u, "")}/${entry.name}`, state.knowledgeCommit, 64 * 1024);
          if (text === undefined) return undefined;
          files.push({ path: entry.name, content: text });
        }
        return files;
      } catch { return undefined; }
    },
    // The project's own knowledge folders beyond the defaults live in its config file; the defaults are already refused everywhere, and the config's own apply refuses a spec folder inside the ones it names.
    forbiddenFolders: async () => projectForbiddenFolders(),
    republishItem: async (taskId) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
      const workflow = task?.workflow;
      if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.candidate === undefined) return undefined;
      // The step that waited for the spec: the code review (before it) or the code pull request (after it).
      const kind = workflow.stage === "REVIEW" && workflow.state === "WAITING" ? "REVIEW" as const : workflow.stage === "PULL_REQUEST" && workflow.state === "READY" ? "PUBLISH" as const : undefined;
      if (kind === undefined) return undefined;
      const row = workflowDispatchItem(dependencies.tableName, taskId, workflow.revision, kind, workflow.candidate.digest, new Date().toISOString());
      // Overwrites a row that is still waiting: the publication is due again now.
      return row.Put === undefined ? undefined : { Put: { TableName: row.Put.TableName, Item: row.Put.Item } };
    },
  };
}

/**
 * Publishes a task's spec: the BROKER makes the commit and the branch through GitHub with its own token (see spec/publish.ts), opens the pull request through the connection, and writes the index row a later
 * delivery finds the task by. Returns the outcome the gate records; `transient` when GitHub could not be asked now.
 */
export function publishSpecFilesOf(dependencies: AwsBrokerDependencies): (task: DeveloperTaskRecord, state: SpecState, branch: string) => Promise<SpecPublishOutcome> {
  return async (task, state, branch) => {
    try {
      if (state.files === undefined) return { ok: false, transient: false };
      const { meta, scope, host, client } = await metaClient(dependencies, task, "push");
      const folder = commonFolderOf(state.files.map((file) => file.path));
      const issuer = dependencies.developer?.issuer;
      const published = await publishSpec({
        git: client,
        pullRequests: {
          open: async (input) => {
            const opened = await host.reconcileChangeRequest({ repository: { url: meta.url }, sourceBranch: input.headBranch, targetBranch: input.baseBranch, title: input.title, body: input.body, draft: false }, scope);
            return { number: Number(opened.ref.id), url: opened.ref.url, reconciled: opened.reconciled };
          },
          read: async (number) => {
            const details = await host.getChangeRequest(changeRequestRef(meta.url, number), scope);
            return { head: details.headRevision, title: details.title, body: details.body };
          },
          close: async (number) => { await host.updateChangeRequest(changeRequestRef(meta.url, number), { state: "closed" }, scope); },
        },
      }, {
        files: state.files, folder, baseCommit: state.knowledgeCommit, baseBranch: meta.defaultBranch, branch, title: specPullRequestTitle(task.title),
        body: specPullRequestBody({ taskTitle: task.title, requirementCount: state.requirementCount ?? 0, ...(specDesignLineOf(task) === undefined ? {} : { designLine: specDesignLineOf(task) }), ...(issuer === undefined ? {} : { taskPageUrl: taskPageUrl(issuer, task.taskId) }) }), forbiddenFolders: projectForbiddenFolders(),
      });
      const full = githubRepositoryFullName(meta.url);
      await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...specPullRequestKey(full, published.number), entityType: "SPEC_PULL_REQUEST", taskId: task.taskId, number: published.number, url: published.url, repositoryUrl: meta.url } }));
      return { ok: true, pullRequest: { number: published.number, url: published.url, repositoryUrl: meta.url, headBranch: branch, commit: published.commit } };
    } catch (error) {
      // A refusal that will not pass (GitHub 403/404/422, no credential, no meta repository) is permanent; a GitHub 5xx or 429 or a network error may pass.
      console.log(JSON.stringify({ component: "broker", event: "spec.publish_failed", error: error instanceof Error ? error.name : "unknown", transient: classifyPublishError(error) }));
      return { ok: false, transient: classifyPublishError(error) };
    }
  };
}

/** The folder common to a spec's files, with a trailing slash ("" when they share none). */
export function commonFolderOf(paths: readonly string[]): string {
  const folders = paths.map((path) => path.split("/").slice(0, -1));
  const first = folders[0] ?? [];
  let length = first.length;
  for (const folder of folders) { let same = 0; while (same < length && folder[same] === first[same]) same += 1; length = same; }
  return first.slice(0, length).join("/") === "" ? "" : `${first.slice(0, length).join("/")}/`;
}

/** Whether a SPEC_WRITE operation has ended (any way), read from the operation's own record. */
export function specOperationEndedOf(dependencies: AwsBrokerDependencies): (task: DeveloperTaskRecord, operationId: string) => Promise<boolean> {
  return async (task, operationId) => {
    const operation = await getItem<{ status?: string }>(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${operationId}` });
    return operation !== undefined && operation.status !== undefined && ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(operation.status);
  };
}

/** One file of a repository at a commit, through the code host the repository's record names, bounded. Undefined when the host cannot say or the file is not there or is too large. */
export function readMetaFileOf(dependencies: AwsBrokerDependencies): (task: DeveloperTaskRecord, repositoryUrl: string, path: string, commit: string, maxBytes: number) => Promise<string | undefined> {
  return async (task, repositoryUrl, path, commit, maxBytes) => {
    try {
      // P6: the size cap is the port's own (`maxBytes`), so the read is the host's, whichever host it is (P5d had it GitHub's alone). An unknown host kind is refused by the router (also "not there").
      const host = await hostOfTaskRepository(dependencies, task, { url: repositoryUrl });
      if (host.kind === GITHUB_HOST_KIND && dependencies.githubPullRequests.getFileAtCommit === undefined) return undefined;
      return (await host.fileAtRevision({ url: repositoryUrl }, path, commit, await githubScopeOf(dependencies, task), { maxBytes })) ?? undefined;
    } catch {
      return undefined;
    }
  };
}

/** The most reviewers whose access is looked up for one read of a spec pull request. More than this and the list is reported as incomplete: no approval is read from it. */
const REVIEWERS_CHECKED_MAX = 50;

/**
 * GitHub's view of a spec pull request: its head, state and reviews, through the task's own connection. Only each reviewer's LATEST decisive review (approved, changes requested) of the recorded head is looked
 * up (a comment, a dismissal or an old review costs nothing and never uses up a limit); it is `eligible` only when its author is a person (not a bot, not the app) with write or admin access to the meta
 * repository. A look-up that fails makes that review ineligible. If more reviewers than the bound need a look-up, the list is reported incomplete, so no approval is read from it and nothing fails open.
 * Undefined when the pull request itself cannot be read.
 */
export function readSpecPullRequestOf(dependencies: AwsBrokerDependencies): (task: DeveloperTaskRecord, repositoryUrl: string, number: number) => Promise<SpecPullRequestFacts | undefined> {
  return async (task, repositoryUrl, number) => {
    try {
      // P5d: the pull request and each reviewer's standing come from the code host the repository's record names; an unknown kind is refused (read as "cannot say").
      const host = await hostOfTaskRepository(dependencies, task, { url: repositoryUrl });
      const github = dependencies.githubPullRequests;
      // A GitHub provider built without these reads (a harness) cannot say, as before; the port itself always can.
      if (host.kind === GITHUB_HOST_KIND && github.getPullRequestStatus === undefined) return undefined;
      const standingKnown = host.kind !== GITHUB_HOST_KIND || github.getRepositoryPermission !== undefined || github.getRepositoryStanding !== undefined;
      const scope = await githubScopeOf(dependencies, task);
      const read = await host.changeRequestStatus(changeRequestRef(repositoryUrl, number), scope);
      // A review whose host names no account for the reviewer is never an approval (`approvalReviewsOf`); it may still object.
      const status = { state: read.state, headSha: read.headRevision, reviewsIncomplete: read.reviewsIncomplete, reviews: approvalReviewsOf(read.reviews) };
      const latest = new Map<string, number>();
      status.reviews.forEach((review, index) => {
        if (review.commitId !== status.headSha) return;
        if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") latest.set(review.githubUserId, index);
      });
      const toCheck = [...latest.values()].filter((index) => ["APPROVED", "CHANGES_REQUESTED"].includes(status.reviews[index]!.state));
      const tooMany = toCheck.length > REVIEWERS_CHECKED_MAX;
      const eligible = new Map<number, boolean>();
      // A look-up that ERRORS (not a clean "none") leaves that reviewer's standing unknown. For an approver that means no approval; for an objector it must not mean the objection is ignored, so any error makes the list incomplete.
      let lookupFailed = false;
      if (!tooMany) {
        await Promise.all(toCheck.map(async (index) => {
          const review = status.reviews[index]!;
          const person = review.userType !== "Bot" && !/\[bot\]$/iu.test(review.login) && standingKnown;
          const level = person ? await host.standing({ url: repositoryUrl }, { login: review.login }, scope).then((standing) => standing.permission).catch(() => { lookupFailed = true; return "none" as const; }) : "none";
          eligible.set(index, person && (level === "write" || level === "admin"));
        }));
      }
      const reviews = status.reviews.map((review, index) => ({ state: review.state, commitId: review.commitId, login: review.login, userId: review.githubUserId, eligible: eligible.get(index) === true }));
      return { state: status.state, headSha: status.headSha, reviews, ...(status.reviewsIncomplete === true || tooMany || lookupFailed ? { reviewsIncomplete: true } : {}) };
    } catch {
      return undefined;
    }
  };
}

/**
 * A GitHub delivery about a pull request: when it is a task's spec pull request (an index row says so), GitHub is read and the spec's state follows what people did (an edit asks the owner "re-plan or keep?",
 * an approval releases a `spec_first` hold), and the held code publication is made due again. Anything else costs one read. Never throws: a failure here only means the next look at the held step does it.
 */
export async function handleSpecPullRequestEvent(dependencies: AwsBrokerDependencies, event: { kind: string; fullName: string; number: number }): Promise<void> {
  if (event.kind !== "PULL_REQUEST" && event.kind !== "PR_COMMENT") return;
  try {
    const index = await getItem<{ taskId?: string }>(dependencies, specPullRequestKey(event.fullName, event.number));
    if (index?.taskId === undefined) return;
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(index.taskId));
    if (task === undefined || task.closedAt !== undefined) return;
    const read = readSpecPullRequestOf(dependencies);
    const environment = specEndEnvironmentOf(dependencies);
    const refreshed = await refreshSpecState({
      store: environment.store, now: () => environment.now(),
      read: async (state) => state.specPullRequest === undefined ? undefined : read(task, state.specPullRequest.repositoryUrl, state.specPullRequest.number),
    }, task.taskId);
    if (!refreshed.changed) return;
    const again = await environment.republishItem(task.taskId);
    if (again?.Put !== undefined) await dependencies.documentClient.send(new PutCommand({ TableName: again.Put.TableName, Item: again.Put.Item }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "spec.pull_request_event_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * The three spec seams of the task route dependencies, from the broker's own dependencies: read a file of the meta repository at a commit, read the spec pull request, publish the spec. Every
 * place the broker builds route dependencies for a task (the HTTP routes, a Slack press, the sweep) takes them from here, so a gate that needs the spec never waits on a path that lacks one.
 */
export function specSeamsOf(dependencies: AwsBrokerDependencies) {
  return {
    readMetaFile: readMetaFileOf(dependencies),
    readSpecPullRequest: readSpecPullRequestOf(dependencies),
    publishSpecFiles: publishSpecFilesOf(dependencies),
  };
}
