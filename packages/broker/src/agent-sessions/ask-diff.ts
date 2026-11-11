// Live interaction A2: the diff an Ask is given. While the task's worker is up, a peek (peek-client.ts) shows the working tree as it is now; when there is no peek (no worker, an older worker, a
// timeout, the task is over) the pull request's own diff is used, as the session diff route reads it. Either way the reader only hands over data: which of it an audience may see, and its
// redaction and size, are decided again in `buildAskContext` (a Slack tier never receives patch text whatever this returns). A reader that fails gives nothing; the Ask is built without a diff.
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import type { OrgId, PeekAnswer } from "@rovara-code/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { AskContextData, AskContextReaders } from "./ask-context.js";
import type { PeekClient } from "./peek-client.js";

/** The pull request reads the session diff route uses (`SessionDiffDependencies["diff"]`). */
export interface AskPullRequestDiffPort {
  pullRequests(workspaceId: string): Promise<NonNullable<DeveloperTaskView["pullRequests"]>>;
  repository(orgId: OrgId, project: string, revision: number, repository: string): Promise<string | undefined>;
  files(repositoryUrl: string, number: number, options: { page: number }, scope: { orgId: OrgId }): Promise<{ files: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>; nextPage?: number }>;
}

type Diff = NonNullable<AskContextData["diff"]>;

const PULL_REQUESTS_MAX = 3;

/** Splits one unified diff into the patch of each file, by its `diff --git a/<path> b/<path>` header. Text before the first header (a repository banner) belongs to no file and is dropped. */
export function splitPatchByFile(patch: string): Array<{ path: string; patch: string }> {
  const out: Array<{ path: string; patch: string }> = [];
  let repository = "";
  let current: { path: string; lines: string[] } | undefined;
  const flush = (): void => { if (current !== undefined) out.push({ path: current.path, patch: current.lines.join("\n") }); current = undefined; };
  for (const line of patch.split("\n")) {
    const banner = /^## repository (.+)$/u.exec(line);
    if (banner !== null) { flush(); repository = banner[1]!; continue; }
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header !== null) { flush(); current = { path: repository === "" ? header[2]! : `${repository}/${header[2]!}`, lines: [line] }; continue; }
    current?.lines.push(line);
  }
  flush();
  return out;
}

/** A peek as the Ask's diff. A path is shown with its repository name only when the workspace has more than one repository. */
export function diffFromPeek(answer: PeekAnswer): Diff {
  const several = new Set([...answer.files, ...answer.untracked].map((file) => file.repository)).size > 1;
  const name = (repository: string, path: string): string => (several ? `${repository}/${path}` : path);
  const files = [
    ...answer.files.map((file) => ({ path: name(file.repository, file.path), additions: file.additions, deletions: file.deletions })),
    ...answer.untracked.map((file) => ({ path: `${name(file.repository, file.path)} (new, not yet tracked)`, additions: 0, deletions: 0 })),
  ];
  // The patch's file headers carry the repository banner only for several repositories; strip the banner when there is one repository so the paths match the file list.
  const patches = splitPatchByFile(several ? answer.patch : answer.patch.replace(/^## repository .+$/gmu, ""));
  return { source: "working_tree", files, ...(patches.length === 0 ? {} : { patches }) };
}

async function pullRequestDiff(port: AskPullRequestDiffPort, task: DeveloperTaskRecord): Promise<Diff | undefined> {
  if (task.workspaceId === undefined || task.orgId === undefined) return undefined;
  const pullRequests = (await port.pullRequests(task.workspaceId)).slice(0, PULL_REQUESTS_MAX);
  const files: Array<{ path: string; additions: number; deletions: number }> = [];
  const patches: Array<{ path: string; patch: string }> = [];
  for (const pullRequest of pullRequests) {
    const repository = await port.repository(task.orgId, task.project, task.startingRevision, pullRequest.repository);
    if (repository === undefined) continue;
    const page = await port.files(repository, pullRequest.number, { page: 1 }, { orgId: task.orgId });
    for (const file of page.files) {
      files.push({ path: file.filename, additions: file.additions, deletions: file.deletions });
      if (file.patch !== undefined) patches.push({ path: file.filename, patch: file.patch });
    }
  }
  return files.length === 0 ? undefined : { source: "pull_request", files, ...(patches.length === 0 ? {} : { patches }) };
}

/** The `diff` reader of `askContext`: a peek first, then the pull request's diff, then nothing. */
export function createAskDiffReader(sources: { peek?: PeekClient | undefined; pullRequests?: AskPullRequestDiffPort | undefined }): NonNullable<AskContextReaders["diff"]> {
  return async (task) => {
    if (sources.peek !== undefined) {
      const answer = await sources.peek(task).catch(() => undefined);
      if (answer !== undefined) return diffFromPeek(answer);
    }
    if (sources.pullRequests === undefined) return undefined;
    try { return await pullRequestDiff(sources.pullRequests, task); } catch { return undefined; }
  };
}
