// Plan 3 Task 14b: `GET` and `PUT /v1/app/projects/{p}/connectors/github/comment-triggers`, the review and the request of an opt-out of the repository-level
// comment rule. Both are for an org owner or admin only (a maintainer who is not one gets 403), and both are reached with a person's token alone: an agent
// operation capability (scope `agent-tools`) is not a developer token, so it never gets past authentication (401). `PUT` applies nothing: it records a
// pending change that an org admin confirms on the confirmation page (`202 { confirmUrl }`).
import { COMMENT_TRIGGER_COVERAGE_NOTE, CommentTriggerOptOutRequestSchema, CommentTriggerRepositorySchema, agentXError, projectArchivedMessage, type OrgId } from "@rovara-code/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { readProjectMeta } from "../developer/project-roles.js";
import type { AgentCaller } from "./access.js";
import type { ApprovalDependencies } from "./approvals.js";
import { projectRepository, requestOptOut, reviewRepository, type RepositoryTriggerView } from "./comment-trigger-optouts.js";
import { roleOnProject } from "./roster.js";

export const COMMENT_TRIGGERS_PATH = /^\/v1\/app\/projects\/([^/]+)\/connectors\/github\/comment-triggers$/;
const MAX_REVIEWED_REPOSITORIES = 20;

const notThere = () => agentXError("NOT_FOUND", "route not found");
const notOneOfTheirs = () => agentXError("CONFIG_INVALID", "repository: that is not one of this project's repositories");

function requireOrgAdmin(caller: AgentCaller): void {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") {
    throw agentXError("FORBIDDEN", "Only an org owner or admin can review or change a project's opt-out of the comment-triggered workflow rule.");
  }
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/** The project's repositories to review: the one named by `?repository=`, or each of the project's GitHub repositories. */
async function repositoriesToReview(deps: ApprovalDependencies, orgId: OrgId, project: string, named: string | null): Promise<string[]> {
  if (named !== null) {
    const parsed = CommentTriggerRepositorySchema.safeParse(named);
    const found = parsed.success ? await projectRepository(deps, orgId, project, parsed.data) : undefined;
    if (found === undefined) throw notOneOfTheirs();
    return [found];
  }
  const found: string[] = [];
  for (const repository of await deps.projectRepositories?.(orgId, project) ?? []) {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/iu.exec(repository.url);
    if (match !== null) found.push(`${match[1]!}/${match[2]!}`.toLowerCase());
  }
  // One scan can take most of the time a request has, so a project with several repositories is asked about one at a time.
  if (found.length > 1) {
    throw agentXError("CONFIG_INVALID", `repository: this project has several repositories; name one with ?repository= (${[...found].sort().slice(0, MAX_REVIEWED_REPOSITORIES).join(", ")})`);
  }
  return found;
}

async function review(deps: ApprovalDependencies, caller: AgentCaller, project: string, url: URL): Promise<{ project: string; repositories: RepositoryTriggerView[]; coverage: string }> {
  const repositories: RepositoryTriggerView[] = [];
  for (const repository of await repositoriesToReview(deps, caller.orgId, project, url.searchParams.get("repository"))) {
    repositories.push(await reviewRepository(deps, { orgId: caller.orgId, project, repository }));
  }
  return { project, repositories, coverage: COMMENT_TRIGGER_COVERAGE_NOTE };
}

async function ask(deps: ApprovalDependencies, caller: AgentCaller, project: string, body: unknown): Promise<StatusReply> {
  const parsed = CommentTriggerOptOutRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // A field the caller made up is not repeated back.
    const words = issue?.code === "unrecognized_keys" ? "has a field this request does not take" : issue?.message ?? "is not valid";
    throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${words}`);
  }
  if ((await readProjectMeta(deps, caller.orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  const asked = await requestOptOut(deps, caller, { ...parsed.data, project });
  return new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: asked.confirmUrl, changes: asked.changes });
}

/**
 * The comment-trigger routes of a project. The caller's role is the membership's, read for this request. A project the caller has no role on, and a
 * project that doesn't exist, answer alike.
 */
export async function routeCommentTriggers(deps: ApprovalDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL, rawProject: string): Promise<unknown> {
  if (request.method !== "GET" && request.method !== "PUT") throw notThere();
  requireOrgAdmin(caller);
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name"); }
  await roleOnProject(deps, caller, project);
  return request.method === "GET" ? review(deps, caller, project, url) : ask(deps, caller, project, jsonBody(request));
}
