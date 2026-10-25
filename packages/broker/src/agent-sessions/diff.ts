import { DIFF_FILES_PAGE_MAX, DIFF_PATCH_MAX_BYTES, SessionDiffSchema, agentXError, redactText, type OrgId, type SessionDiff } from "@agentx/contracts";
import { sessionView, type SessionReadCaller, type SessionReadDependencies } from "./read.js";
export interface SessionDiffDependencies extends SessionReadDependencies {
 diff?: {
  repository(orgId: OrgId, project: string, revision: number, repository: string): Promise<string | undefined>;
  files(repositoryUrl: string, number: number, options: { page: number }, scope: { orgId: OrgId }): Promise<{ files: Array<{ filename: string; status: string; previous_filename?: string; additions: number; deletions: number; patch?: string }>; nextPage?: number }>;
 };
}
const missing = () => agentXError("NOT_FOUND", "diff not found");
export async function sessionDiff(deps: SessionDiffDependencies, caller: SessionReadCaller, sessionId: string, query: { repository: string; number: number; page: number }): Promise<SessionDiff> {
 const session = await sessionView(deps, caller, sessionId);
 if (deps.diff === undefined || session.project === undefined || !Number.isSafeInteger(query.number) || query.number < 1 || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 10_000) throw missing();
 // RULING Q36: unspecified upstream omission has no guessed binary/size reason.
 // PLAN4: chain PR enumeration needs the owning readable-section contract; never guess a step task.
 if (session.body?.kind !== "task") throw missing();
 const task = session.body.task;
 const pr = task.pullRequests?.find(item => item.repository === query.repository && item.number === query.number);
 if (pr === undefined) throw missing();
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
