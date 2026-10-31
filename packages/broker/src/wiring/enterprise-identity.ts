// Enterprise foundations, Wave 2 (P7, I2, I3): the one place the pieces of this lane are put together for the broker. The handler and the publication step call THESE functions, a line each, and
// `tests/contract/enterprise-identity-wiring.test.ts` checks that every call site that has been wired still calls them, so a wiring line that is later lost fails a test. The lines are applied in the
// broker's files; the test requires all of them.
import { WorkflowDecisionRecordSchema, type EditionPolicy, type OrgId } from "@agentx/contracts";
import { dynamoAttributionLinkStore, type AttributionLinkStore } from "../attribution/links.js";
import { dynamoAttributionReader, resolveActingAttribution, type ResolvedAttribution } from "../attribution/resolve.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** What the route dependencies take from the broker's dependencies: the edition policy (built once at start by `installEditionPolicy` in `aws/broker/edition-wiring.ts`, the one source), when the install has one. Spread into every object that becomes `DeveloperRouteDependencies`. */
export function routeEditionDependencies(dependencies: { editionPolicy?: EditionPolicy | undefined }): { editionPolicy?: EditionPolicy } {
  return dependencies.editionPolicy === undefined ? {} : { editionPolicy: dependencies.editionPolicy };
}

/** The person who approved the plan: the latest APPROVE at the plan's gate by a person (the task owner or a project admin), never the broker's own automatic decisions. */
export function approverOfPlan(decisions: readonly unknown[]): string | undefined {
  let approver: { id: string; at: string } | undefined;
  for (const raw of decisions) {
    const parsed = WorkflowDecisionRecordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const decision = parsed.data;
    if (decision.decision !== "APPROVE" || decision.actorRole === "AGENTX") continue;
    if (decision.source !== undefined && decision.source !== "GATE") continue;
    if (approver === undefined || decision.at >= approver.at) approver = { id: decision.actorId, at: decision.at };
  }
  return approver?.id;
}

export interface AttributionTables { documentClient: DocumentClient; stateTable: string; signInTable: string; teamRecordTable: string }

/** The audit page, filtered to the events that open a change request. Lets an authorized person find the record; names no one. */
export const auditLinkFor = (origin: string): string => `${new URL(origin).origin}/v1/app/audit/view?action=pull_request.opened`;
const auditLinkOrUndefined = (origin: string | undefined): string | undefined => {
  if (origin === undefined) return undefined;
  try { return auditLinkFor(origin); } catch { return undefined; }
};

/**
 * The attribution for one publication, with its reference rows stored. `requesterId` is the task's requester; `plan` is the workflow's decisions (the approver comes from them).
 * Throws when the reference row cannot be stored: the publication is not sent with a reference that leads nowhere erasable.
 */
export async function attributionForPublication(
  tables: AttributionTables,
  input: { orgId: OrgId; taskId: string; requesterId: string | undefined; decisions: readonly unknown[]; origin?: string | undefined; links?: AttributionLinkStore },
): Promise<ResolvedAttribution> {
  const reader = dynamoAttributionReader(tables);
  const links = input.links ?? dynamoAttributionLinkStore({ documentClient: tables.documentClient, tableName: tables.stateTable });
  const approverId = approverOfPlan(input.decisions);
  return resolveActingAttribution(reader, links, { orgId: input.orgId, taskId: input.taskId, requesterId: input.requesterId, approverId, auditUrl: auditLinkOrUndefined(input.origin) });
}

/**
 * Erasure of a person, for the attribution, in an order that survives a failure:
 *   1. read the person's rows (the list of descriptions that name them);
 *   2. delete the reference rows: every commit reference now leads nowhere (this is what matters in git history);
 *   3. rewrite the person's line in each description (`rewrite(taskId, role)` is the caller's: it finds the task's change request and writes `rewriteAttributionBody`'s result);
 *   4. only when every rewrite succeeded, delete the person's own rows.
 * If a rewrite throws, the person's rows are still there, so running the erasure again finds the same list and repeats the cut and the rewrites (all safe to repeat). Returns how many
 * descriptions were rewritten.
 */
export async function eraseAttributionOfPerson(
  links: AttributionLinkStore,
  orgId: OrgId,
  developerId: string,
  rewrite: (taskId: string, role: "requester" | "approver") => Promise<void>,
): Promise<number> {
  const found = await links.linksOf(orgId, developerId);
  await links.cutReferences(orgId, found);
  for (const link of found) await rewrite(link.taskId, link.role);
  await links.deletePersonRows(orgId, found);
  return found.length;
}

/** The start-time check of P7, named for the one call in the task start. */
export { assertRepositoryHostsKnown } from "../plugins/registry.js";
