import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { requireSessionLevel } from "./access.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { DIFF_FILES_PAGE_MAX, DIFF_PATCH_MAX_BYTES, SessionDiffSchema, ChainRunViewSchema, CHAIN_MAX_STEP_RUNS, projectAllows, agentXError, redactText, type OrgId, type SessionDiff } from "@rovara-code/contracts";
import { type DeveloperTaskView } from "@agentx/cloud-contracts";
import { type SessionReadCaller, type SessionReadDependencies } from "./read.js";
export interface SessionDiffDependencies extends SessionReadDependencies {
 diff?: {
  pullRequests(workspaceId: string): Promise<NonNullable<DeveloperTaskView["pullRequests"]>>;
  repository(orgId: OrgId, project: string, revision: number, repository: string): Promise<string | undefined>;
  files(repositoryUrl: string, number: number, options: { page: number }, scope: { orgId: OrgId }): Promise<{ files: Array<{ filename: string; status: string; previous_filename?: string; additions: number; deletions: number; patch?: string }>; nextPage?: number }>;
 };
}
const missing = () => agentXError("NOT_FOUND", "diff not found");
export async function sessionDiff(deps: SessionDiffDependencies, caller: SessionReadCaller, sessionId: string, query: { repository: string; number: number; page: number }): Promise<SessionDiff> {
 const access = await requireSessionLevel(deps, caller, sessionId, "view", "view it");
 const { session } = access;
 if (deps.diff === undefined || session.project === undefined || !Number.isSafeInteger(query.number) || query.number < 1 || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 10_000) throw missing();
 // RULING Q36: unspecified upstream omission has no guessed binary/size reason.
 let task: DeveloperTaskRecord | undefined;
 let pr: NonNullable<DeveloperTaskView["pullRequests"]>[number] | undefined;
 if (session.subject.kind === "task") {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(session.subject.taskId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  task = result.Item as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== caller.orgId || task.taskId !== session.subject.taskId || task.project !== session.project) throw missing();
  pr = (await deps.diff.pullRequests(task.workspaceId)).find(item => item.repository === query.repository && item.number === query.number);
 } else if (session.subject.kind === "chain" && deps.chain !== undefined) {
  const role = await deps.projectMembers.roleOf(caller.orgId, session.project, { developerId: caller.developerId, orgRole: access.orgRole });
  if (role === undefined || !projectAllows(role, "start_tasks")) throw missing();
  const run = ChainRunViewSchema.safeParse(await deps.chain.runView({ kind: "session", developerId: caller.developerId }, session.subject.chainRunId));
  if (!run.success || run.data.sessionId !== session.subject.chainRunId || run.data.project !== session.project || run.data.sections.length > CHAIN_MAX_STEP_RUNS) throw missing();
  for (const section of run.data.sections) {
   if (section.detail === undefined) continue;
   let shown: DeveloperTaskView;
   try { shown = await deps.chain.stepTask({ kind: "session", developerId: caller.developerId }, session.subject.chainRunId, section.seq); }
   catch (error) { if (typeof error === "object" && error !== null && "code" in error && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) continue; throw error; }
   if (shown.taskId !== section.detail.taskId || shown.project !== session.project) throw missing();
   const candidate = shown.pullRequests?.find(item => item.repository === query.repository && item.number === query.number);
   if (candidate === undefined) continue;
   const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(shown.taskId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
   const stored = result.Item as DeveloperTaskRecord | undefined;
   if (stored === undefined || stored.orgId !== caller.orgId || stored.project !== session.project || stored.taskId !== shown.taskId || stored.chain?.chainRunId !== session.subject.chainRunId || stored.startingRevision !== shown.startingRevision) throw missing();
   task = stored; pr = candidate; break;
  }
 }
 if (task === undefined || pr === undefined) throw missing();
 const repository = await deps.diff.repository(caller.orgId, session.project, task.startingRevision, query.repository);
 if (repository === undefined) throw missing();
 let page;
 try { page = await deps.diff.files(repository, query.number, { page: query.page }, { orgId: caller.orgId }); }
 catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "GITHUB_NOT_CONNECTED") throw missing();throw error; }
 const files: SessionDiff["files"] = page.files.slice(0, DIFF_FILES_PAGE_MAX).map(file => {
  const status = file.status === "copied" ? "added" : file.status === "changed" || file.status === "unchanged" ? "modified" : file.status;
  if (!["added", "removed", "modified", "renamed"].includes(status)) throw agentXError("RUNTIME_UNAVAILABLE", "The diff contains an unsupported change type.");
  const patch = file.patch === undefined ? undefined : redactText(file.patch);
  const tooLarge = file.patch !== undefined && (Buffer.byteLength(file.patch, "utf8") > DIFF_PATCH_MAX_BYTES || Buffer.byteLength(patch!, "utf8") > DIFF_PATCH_MAX_BYTES);
  return { path: file.filename, status: status as SessionDiff["files"][number]["status"], additions: file.additions, deletions: file.deletions,
   ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
   ...(tooLarge ? { patchOmitted: "too_large" as const } : patch === undefined ? {} : { patch }) };
 });
 return SessionDiffSchema.parse({ files, ...(page.nextPage === undefined ? {} : { nextPage: page.nextPage }), pullRequest: pr && { repository: pr.repository, number: pr.number, url: pr.url } });
}
