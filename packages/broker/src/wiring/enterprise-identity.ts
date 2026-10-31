// Enterprise foundations, Wave 2 (P7, I2, I3): the one place the pieces of this lane are put together for the broker. The handler and the publication step call THESE functions, a line each, and
// `tests/contract/enterprise-identity-wiring.test.ts` checks that every call site that has been wired still calls them, so a wiring line that is later lost fails a test. The lines still to be
// applied (they are in hot files another builder is editing) are listed in `.superpowers/sdd/ent-w2-identity/report.md`; once a file imports this module the test requires all of its lines.
import {
  WorkflowDecisionRecordSchema, editionPolicy, resolveEdition,
  type EditionPolicy, type OrgId,
} from "@agentx/contracts";
import { dynamoAttributionLinkStore, type AttributionLinkStore } from "../attribution/links.js";
import { dynamoAttributionReader, resolveActingAttribution, type ResolvedAttribution } from "../attribution/resolve.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/**
 * The install's edition policy from its environment (`ROVARA_EDITION`, stamped at deploy time). An install with NO stamp is an existing install: it gets no policy, and so runs as today
 * (no Auditor can sign in, a Slack identity with no record stays an implicit member); it is never read as Enterprise. A stamp that is not an edition refuses to start.
 */
export function installEditionPolicy(env: Readonly<Record<string, string | undefined>>): EditionPolicy | undefined {
  const configured = env["ROVARA_EDITION"];
  if (configured === undefined || configured === "") return undefined;
  return editionPolicy(resolveEdition({ configured, cloud: undefined, allowDerivedFromCloud: false }));
}

/** What the route dependencies and the broker's own dependencies take from the install: the edition policy, when the install has one. Spread into every object that becomes `DeveloperRouteDependencies`. */
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

/**
 * The attribution for one publication, with its reference rows stored. `requesterId` is the task's requester; `plan` is the workflow's decisions (the approver comes from them).
 * Throws when the reference row cannot be stored: the publication is not sent with a reference that leads nowhere erasable.
 */
export async function attributionForPublication(
  tables: AttributionTables,
  input: { orgId: OrgId; taskId: string; requesterId: string | undefined; decisions: readonly unknown[]; origin: string; links?: AttributionLinkStore },
): Promise<ResolvedAttribution> {
  const reader = dynamoAttributionReader(tables);
  const links = input.links ?? dynamoAttributionLinkStore({ documentClient: tables.documentClient, tableName: tables.stateTable });
  const approverId = approverOfPlan(input.decisions);
  return resolveActingAttribution(reader, links, { orgId: input.orgId, taskId: input.taskId, requesterId: input.requesterId, approverId, auditUrl: auditLinkFor(input.origin) });
}

/**
 * Erasure of a person, for the attribution: deletes every reference row (so every commit reference leads nowhere) and rewrites the person's line in each change request description they
 * were named in. `rewrite(taskId, role)` is the caller's: it finds the task's change request and writes the description `rewriteAttributionBody` gives. Returns how many descriptions were
 * asked to be rewritten; a rewrite that throws stops the erasure with the rows already gone, and running it again finds nothing more to delete but the caller can retry from the tasks it logged.
 */
export async function eraseAttributionOfPerson(
  links: AttributionLinkStore,
  orgId: OrgId,
  developerId: string,
  rewrite: (taskId: string, role: "requester" | "approver") => Promise<void>,
): Promise<number> {
  const erased = await links.eraseFor(orgId, developerId);
  for (const link of erased) await rewrite(link.taskId, link.role);
  return erased.length;
}

/** The start-time check of P7, named for the one call in the task start. */
export { assertRepositoryHostsKnown } from "../plugins/registry.js";
