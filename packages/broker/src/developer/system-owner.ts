// The system owner of automatic runs, broker side (owner decision 2026-11-02; contracts `system-owner.ts`). A system owner is NOT a person: it has no sign-in record, no org membership, no project grant, no task slot of
// its own to spend, no model key and no Slack link. Everything that turns "the owner of this task" into a person (a caller, a sign-in method, a member to ask) goes through `personOwnerOf` or `requirePerson`, which
// REFUSE a system owner: the task's work is done by the broker's own automatic path, and nothing can act AS the system owner from outside it.
//   systemOwnerCaller     the in-memory caller `startTask` runs a system-owned start with; only `startAutomaticTask`'s path builds it, and `startTask` itself refuses it without an automatic mark
//   isSystemOwned         whether a task belongs to a system owner (by its stored owner, never by a field a client can send)
//   personOwnerOf         the owner as a person, or TASK_ACCESS_DENIED for a system owner
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { readProjectMeta } from "./project-roles.js";
import { SYSTEM_OWNER_SESSION_ID, agentXError, isSystemOwnerId, orgMetaKey, systemOwnerIdOf, systemOwnerName, type DeveloperSignInMethod, type OrgId } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes/types.js";
import { tryEffectiveTaskOwner, type TaskOwner, type TaskOwnerSource } from "./task-records.js";

/** The words a refusal gives when something tries to act as, or on behalf of, a project's system owner. */
export const SYSTEM_OWNER_REFUSAL = "This work belongs to a project's automatic runs, not to a person, so it can't be done that way.";

/** Whether a task is owned by a system owner: its effective owner's id (never a client's field). A task whose owner can't be read is not. */
export function isSystemOwned(task: TaskOwnerSource): boolean {
  const owner = tryEffectiveTaskOwner(task);
  return owner !== undefined && isSystemOwnerId(owner.developerId);
}

/** Refuses a system owner's id where a person is needed. */
export function requirePerson(developerId: string, what = "act"): void {
  if (isSystemOwnerId(developerId)) throw agentXError("TASK_ACCESS_DENIED", `${SYSTEM_OWNER_REFUSAL} (${what})`);
}

/** The owner read as a person: its sign-in method is a real one. A system owner is refused. */
export function personOwnerOf(owner: TaskOwner): TaskOwner & { provider: DeveloperSignInMethod } {
  if (isSystemOwnerId(owner.developerId) || owner.provider === "system") throw agentXError("TASK_ACCESS_DENIED", SYSTEM_OWNER_REFUSAL);
  return owner as TaskOwner & { provider: DeveloperSignInMethod };
}

/**
 * The caller of a system-owned start. It exists only in memory, for the one start; it is no session, carries no Slack link and no org role beyond the plain member one (the system start reads its project access from
 * `systemProjectAccess`, never from a role). `amr` is a placeholder the task record does not keep: the record says `system`.
 */
export function systemOwnerCaller(orgId: OrgId, project: string): DeveloperCaller {
  return { developerId: systemOwnerIdOf(orgId, project), sessionId: SYSTEM_OWNER_SESSION_ID, amr: "cloud", name: systemOwnerName(project), orgId, orgRole: "member" };
}

/** Whether a caller is a system owner's (only `systemOwnerCaller` makes one). */
export const isSystemOwnerCaller = (caller: Pick<DeveloperCaller, "developerId"> & { sessionId?: string | undefined }): boolean => isSystemOwnerId(caller.developerId) && caller.sessionId === SYSTEM_OWNER_SESSION_ID;

// ---- the standing of a system owner

type Reader = { send(command: unknown): Promise<unknown> };

/**
 * Whether a project's system owner still has standing to run: the company is open and the project is not archived. This is the same rule new work meets (`requireNewWorkAllowed`: the project's PROJECT_META row, read by
 * `readProjectMeta`, refuses only when it says archived), so a project with no meta row of its own (a project from before the row existed) stands, as it does for a person. A system owner has no member record to lose, so
 * THIS replaces the person-membership checks (the removed-creator rule, the dispatch fence) for a system-owned task. A read that fails is thrown to the caller (nothing is dispatched on doubt).
 */
export async function systemOwnerStands(deps: { documentClient: Reader; tableName: string }, orgId: OrgId, project: string): Promise<boolean> {
  const get = async (key: { pk: string; sk: string }) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const [org, meta] = await Promise.all([get(orgMetaKey(orgId)), readProjectMeta(deps as Parameters<typeof readProjectMeta>[0], orgId, project)]);
  if (org?.closedAt !== undefined || org?.closingAt !== undefined) return false;
  return meta?.status !== "archived" && (meta as { archivedAt?: unknown } | undefined)?.archivedAt === undefined;
}
