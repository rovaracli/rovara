// Part of the broker (split out of ../broker.ts): project registration, cloud project creation, the project catalog and setup admission.

import { commitRegisteredProjectAllowedDomains, type AppliedDomainProposalProof } from "../../org/project-allowed-domains.js";
import { readAllowedDomainActorConditions } from "../../org/second-person-evidence.js";
import { planLegacyDomainNarrowing } from "../../org/legacy-domain-narrowing.js";
import { planInitialProjectDomains } from "../../org/project-domain-initial.js";
import { isAllowedDomainWidening, refuseAllowedDomainWidening } from "../../org/allowed-domain-policy.js";
import { approvalGrantChange } from "../../org/approval-membership.js";
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, E2EPolicySchema, E2EScenarioBundleSchema, e2eScenarioBundleDigest, E2ERunBindingSchema, E2ERoundSchema, selectE2EExecutionPlan, verifyE2ESourceSnapshot, AGENTX_PROTOCOL_VERSION, canonicalJson, githubNotConnectedMessage, ProjectDefinitionSchema, approvedToolCount, presentedNameProblems, toolBudget, TOOL_LIMIT, TOOL_WARNING_THRESHOLD, legacyProjectFields, agentXError, projectNameTakenMessage, type ProjectDefinition, githubRepoProjectKey, type RegistrationPreflight, orgMetaKey, orgProjectCatalogKey, projectMetaKey, projectSetupApprovalKey, orgScoped, projectCreateRequestKey, projectRevisionKey, type OrgId, type AuditActor, type AuditEventInput, auditOperatorId, INDEX_EXPIRY_ATTRIBUTE, sameJsonContent, type E2ESourceSnapshot, ProjectSetupExecutionSchema, ProjectSetupOperationSchema, ProjectSetupSessionSchema, projectSetupExecutionKey, projectSetupOperationKey, projectSetupSessionKey, WorkerInvocationSchema } from "@agentx/contracts";
import { compileE2EScenarios, e2ePrivateTransferMaxBytes } from "@agentx/verifier";
import type { AuthenticatedIdentity } from "../../auth.js";
import { z } from "zod";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditActorOf } from "../../audit/plan3-hooks.js";
import { auditedWrite, projectDefinitionAuditEvents } from "../../playbook/project-settings-audit.js";
import { requireSameRequest } from "../../org/request-records.js";
import { unsupportedThinkingLevels } from "@agentx/model-runtime/thinking-levels";
import { resolveConnectors } from "../connector-types.js";
import { requireRepositoryConnected } from "../../org/github-connection.js";
import { readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { cloudProjectDefinition, type CreateProjectInput } from "../../org/cloud-projects.js";
import { requireOrgId } from "../../org/resolve.js";
import { requireProject } from "../project-records.js";
import { admitProjectSetupRuntime, projectSetupBindingDigest, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "../project-setup-runtime-catalog.js";
import { projectSetupTerminalAuthorityChecks } from "../project-setup-terminal-conditions.js";
import { issueProjectSetupCapability } from "../project-setup-capability.js";
import { deriveProjectSetupSourceSmoke } from "../../e2e/project-setup-source-smoke.js";
import { planSetupAccountWrites } from "../e2e-account-registry.js";
import { E2EAccountRegistryError } from "../../e2e/application-account-registry.js";
import { getItem } from "../cancellation.js";
import { PROJECT_RECORD_NEEDS_ADMIN, isConditional } from "../broker-shared.js";
import { assertNoRequalifyHold, rethrowAsDeferredIfHeld, requalifyHoldFence, requalifySetupWorkRow } from "../../e2e/requalify-hold.js";
import { healGithubRepoIndex } from "../../triggers/github-events.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { TransactItems } from "../developer-task-actions.js";
import { credentialRefusals, preflightConnectors, registrationWarnings, type PreflightOutcome } from "../registration-preflight.js";
import { publicWorkspace } from "../../workspaces.js";
import { ownerKeyForSubject, parseRuntimeBinding } from "../lambda.js";
import { membershipRecord, name, object, positiveInteger, uuid, withoutKeys } from "./admin-and-helpers.js";
import { MAX_SETUP_PROPOSAL_BYTES, type AwsBrokerDependencies, type RegisteredProjectRecord } from "./definitions.js";
import { repositoryGateOf, requireRecordProject } from "./dependency-wiring.js";
import { setupAdmissionMatchesExecution } from "./evidence-and-setup.js";
import { projectSetupDomainRecord, projectSetupRuntimeRecord } from "./feedback-and-codebuild.js";
import { getDefaultWorkspace, getMembership, requireAdministrator, requireLatestProject, requireWorkspace } from "./records.js";
import { ensureInstallOrg, githubScope, orgOfRecord } from "./scope-helpers.js";
import { readApprovedSetupSource } from "./task-operations.js";
import { retryWorkspacePreparation } from "./thread-workspaces.js";
import { MEMBERSHIP_PREPARATION_ATTEMPTS, membershipMovedSince, newWorkspacePreparation } from "./workspace-preparation.js";
import { connectorTypeContext } from "./workspace-routes.js";
import { AuditEventInputSchema, orgSettingsKey, projectAiKey } from "@agentx/contracts";
import { nativeSnapshotConditions } from "../../org/native-snapshot-conditions.js";
import { requirePricedTaskStopAdmission } from "../../org/task-stop-unpriced.js";
import { taskStopProjectCreationItems } from "../../org/task-stop-bootstrap.js";

/** The registration request's parse, shared by registerProject and a change plan (spec 025 C4). */
export function parseRegistrationInput(value: unknown): { definition: ProjectDefinition; runtimeBinding: ReturnType<typeof parseRuntimeBinding>; wantsPreflight: boolean; setupApproval?: { proposalRef: string; proposalSha256: string; decision: "approve" | "decline" }; takeover?: { reason: string } } {
  const input = object(value, "project registration");
  const retired = legacyProjectFields(input.definition);
  if (retired.length > 0) {
    throw agentXError("CONFIG_INVALID", `project definition must not contain ${retired.join(", ")}; remove them and register again`);
  }
  const definition = ProjectDefinitionSchema.parse(input.definition);
  const runtimeBinding = parseRuntimeBinding(input.runtimeBinding);
  const setupApproval = input.setupApproval === undefined ? undefined : z.object({
    proposalRef: z.string().min(1).max(512), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "decline"]),
  }).strict().parse(input.setupApproval);
  // Task AUTH1: taking over a project is an explicit request with a reason, never implied by a reason alone and never by anything but the boolean `true`.
  if (input.takeOwnership !== undefined && typeof input.takeOwnership !== "boolean") {
    throw agentXError("CONFIG_INVALID", "takeOwnership must be true or false");
  }
  let takeover: { reason: string } | undefined;
  if (input.takeOwnership === true) {
    const reason = typeof input.takeOwnershipReason === "string" ? input.takeOwnershipReason.trim() : "";
    if (reason === "" || reason.length > TAKEOVER_REASON_MAX) {
      throw agentXError("CONFIG_INVALID", `taking over a project needs a takeOwnershipReason of 1 to ${TAKEOVER_REASON_MAX} characters, recorded with who took it over and when`);
    }
    takeover = { reason };
  }
  // Preflight contacts the vendor, so it runs only when the caller asks; older clients never do.
  return { definition, runtimeBinding, wantsPreflight: input.preflight === true, ...(setupApproval === undefined ? {} : { setupApproval }), ...(takeover === undefined ? {} : { takeover }) };
}

const TAKEOVER_REASON_MAX = 500;

/** Registration's refusals and preflight, for a new revision; registerProject and a change plan share them. */
export async function registrationChecks(dependencies: AwsBrokerDependencies, identity: RegistrationActor, definition: ProjectDefinition, wantsPreflight: boolean, credentialsChecked?: readonly string[]): Promise<PreflightOutcome | undefined> {
  const budget = toolBudget(approvedToolCount(definition));
  const context = connectorTypeContext(dependencies, identity.orgId, async () => githubScope(dependencies, identity.orgId));
  const connectors = () => resolveConnectors(definition, context, dependencies.connectorTypes);
  const nameProblems = presentedNameProblems(definition);
  if (nameProblems.length > 0) throw agentXError("CONFIG_INVALID", nameProblems.join("; "));
  if (budget.refusal) throw agentXError("CONFIG_INVALID", budget.refusal);
  // Spec 053 FR-003: Pi would clamp an unsupported level to another one; refuse the admin's choice instead.
  const levelProblems = definition.models === undefined ? [] : unsupportedThinkingLevels(definition.models);
  if (levelProblems.length > 0) throw agentXError("CONFIG_INVALID", levelProblems.join("; "));
  // The admin route checks every connector's credential; a change from the app checks only the connector it changes (the others show their own status).
  const credentialProblems = await credentialRefusals(connectors().filter((connector) => credentialsChecked === undefined || credentialsChecked.includes(connector.name)), context.credentialRegistry);
  if (credentialProblems.length > 0) throw agentXError("CONFIG_INVALID", credentialProblems.join("; "));
  // A repository the GitHub App cannot reach would otherwise fail only at prepare (#123).
  for (const repository of definition.repositories) {
    await dependencies.checkRepositoryAccess?.(repository, githubScope(dependencies, identity.orgId));
  }
  if (!wantsPreflight) return undefined;
  const result = await preflightConnectors(connectors(), definition, identity.ownerKey);
  if (result.refusals.length > 0) throw agentXError("CONFIG_INVALID", result.refusals.join("; "));
  return { report: result.report, warnings: result.warnings };
}

export type RegistrationResult = { project: Omit<RegisteredProjectRecord, "pk" | "sk">; duplicate: boolean; warnings?: string[]; preflight?: RegistrationPreflight };

/** Who registers a project, and in which org: the org it is written in and the owner key its records name. */
export interface RegistrationActor { orgId: OrgId; ownerKey: string; /** The signed-in subject, recorded when an instance administrator takes a project over (AUTH1). */ subject?: string; /** Who the audit events of the revision name, when the owner key is not a member (the operator's admin route). */ auditActor?: AuditActor }

/** The admin route's registration: an administrator registers a project in their own org and administers it. */
export async function registerProject(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
  checked?: { preflight?: PreflightOutcome },
): Promise<RegistrationResult> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  return registerProjectFor(dependencies, { orgId: requireOrgId(identity.orgId), ownerKey: identity.ownerKey, subject: identity.subject, auditActor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) } }, value, { creatorMembership: "administrator", ...(checked === undefined ? {} : { checked }) });
}

/**
 * The registration itself, for any actor in any org; the caller has already decided that the actor may register. `creatorMembership`
 * says what the actor gets on the project: an administrator row (the admin route), a developer grant written in the same transaction,
 * or none, when the caller grants access itself (a cloud org's owner or admin, ruling R55, is granted like any developer).
 *
 * Plan 2, Task 11: a project's META item (status, description, who created it and when) is written in the transaction that registers its
 * first revision. With `requireNewName` the name must be new in the org: a catalog entry already there (an archived project, or one from
 * before META existed) is PROJECT_NAME_TAKEN, and so is a transaction whose revision, META or catalog condition fails (a TransactionConflict, or a failed setup row, is not: those
 * answer as a retryable conflict and as the admission's own error). `extraItems` are the caller's own transaction items, written with the
 * project (and only then). Without `requireNewName`, registration stays
 * idempotent and writes META only for a project new to the org, leaving a project that predates META without one (it reads as active,
 * created by "unknown").
 */
export async function registerProjectFor(
  dependencies: AwsBrokerDependencies,
  actor: RegistrationActor,
  value: unknown,
  options: { creatorMembership: "administrator" | "developer" | "none"; requireNewName?: boolean; description?: string; extraItems?: Array<Record<string, unknown>>; expectedBaseRevision?: number; appliedDomainProposal?: AppliedDomainProposalProof; checked?: { preflight?: PreflightOutcome }; credentialsChecked?: readonly string[] },
): Promise<RegistrationResult> {
  // Even the minimal registration needs its own action. Reject a provably
  // oversized trusted extension before bootstrap or any other write.
  if ((options.extraItems?.length ?? 0) >= 100) throw agentXError("CONFIG_INVALID", "This project change cannot fit one transaction.");
  const checked = options.checked;
  const orgId = actor.orgId;
  const { definition, runtimeBinding, wantsPreflight, setupApproval, takeover } = parseRegistrationInput(value);
  if (options.appliedDomainProposal !== undefined) {
    // This trusted option is never accepted from a registration JSON body. It
    // dispatches to the shared reviewed transaction, not the legacy retry path.
    if (dependencies.cloud !== true || actor.auditActor?.kind === "operator" || options.creatorMembership !== "none") throw agentXError("FORBIDDEN", "Website proposal approval requires a live company person.");
    if (wantsPreflight || setupApproval !== undefined || takeover !== undefined || options.requireNewName === true || options.description !== undefined
      || options.extraItems !== undefined || options.expectedBaseRevision !== undefined || options.checked !== undefined || options.credentialsChecked !== undefined) throw agentXError("CONFIG_INVALID", "A website proposal cannot authorize other registration changes.");
    const result = await commitRegisteredProjectAllowedDomains({ ...dependencies, signInTableName: dependencies.developer?.signInTableName ?? "", now: Date.now }, {
      orgId, project: definition.name, by: actor.ownerKey, definition, runtimeBinding, proof: options.appliedDomainProposal,
    });
    const registered = await getItem<RegisteredProjectRecord>(dependencies, projectRevisionKey(orgId, definition.name, result.receipt.resultRevision));
    if (registered === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The approved website revision could not be read.");
    return { project: withoutKeys(registered), duplicate: result.duplicate };
  }
  if (options.requireNewName === true && await getItem(dependencies, orgProjectCatalogKey(orgId, definition.name)) !== undefined) {
    throw agentXError("PROJECT_NAME_TAKEN", projectNameTakenMessage(definition.name));
  }
  let setupRuntimeAdmission: ReturnType<typeof admitProjectSetupRuntime>;
  let setupExecutionCreated = false;
  let ownershipTakenOver = false;
  let setupApprovalBinding: RegisteredProjectRecord["setupApproval"];
  let setupApprovedAt = "";
  if (definition.e2e !== undefined || setupApproval !== undefined) {
    if (setupApproval === undefined) throw agentXError("FORBIDDEN", "E2E project registration requires a stored source-backed setup decision");
    const expectedProposalPrefix = `project-setup-proposals/${actor.ownerKey}/`;
    if (!setupApproval.proposalRef.startsWith(expectedProposalPrefix) || setupApproval.proposalRef !== `${expectedProposalPrefix}${setupApproval.proposalSha256}.json`) throw agentXError("FORBIDDEN", "setup approval reference is outside the authenticated administrator scope");
    const approval = await getItem<Record<string, unknown>>(dependencies, projectSetupApprovalKey(orgId, definition.name, setupApproval.proposalSha256));
    if (!approval || approval.ownerKey !== actor.ownerKey || approval.proposalRef !== setupApproval.proposalRef || approval.decision !== setupApproval.decision) throw agentXError("FORBIDDEN", "setup decision is missing, stale, or belongs to another administrator");
    const repository = definition.repositories[0];
    const mapping = approval.identityMapping;
    if (!repository || !mapping || typeof mapping !== "object" || Array.isArray(mapping)
      || (mapping as Record<string, unknown>).registeredRepositoryId !== repository.name
      || typeof approval.repositoryUrl !== "string" || approval.repositoryUrl.toLowerCase() !== repository.url.toLowerCase()) throw agentXError("PROJECT_REVISION_MISMATCH", "registered repository identity does not match the source-backed setup decision");
    if (setupApproval.decision === "approve") {
      if (definition.e2e === undefined || !sameJsonContent(definition.e2e, approval.policy)) throw agentXError("PROJECT_REVISION_MISMATCH", "E2E policy does not match the approved source-backed setup proposal");
    } else if (definition.e2e !== undefined) throw agentXError("FORBIDDEN", "declined setup decision cannot register an E2E policy");
    setupApprovalBinding = { proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256, candidateDigest: String(approval.candidateDigest), decision: setupApproval.decision };
    setupApprovedAt = typeof approval.approvedAt === "string" ? approval.approvedAt : "";
    if (setupApproval.decision === "approve" && definition.e2e !== undefined && dependencies.projectSetupRuntimeCatalogId
      && runtimeBinding.deploymentMode === "ec2-ebs") {
      const bindingDigest = projectSetupBindingDigest(runtimeBinding);
      const catalogItem = await dependencies.documentClient.send(new GetCommand({
        TableName: dependencies.tableName,
        Key: projectSetupRuntimeKey(dependencies.projectSetupRuntimeCatalogId, bindingDigest),
        ConsistentRead: true,
      }));
      const runtimeKey = projectSetupRuntimeKey(dependencies.projectSetupRuntimeCatalogId, bindingDigest);
      const parsedCatalog = ProjectSetupRuntimeRecordSchema.safeParse(projectSetupRuntimeRecord(catalogItem.Item, runtimeKey));
      if (parsedCatalog.success) {
        setupRuntimeAdmission = admitProjectSetupRuntime(parsedCatalog.data, {
          runtimeCatalogId: dependencies.projectSetupRuntimeCatalogId, binding: runtimeBinding,
          scope: "source-interface", now: Date.now(),
        });
      }
    }
  }
  const budget = toolBudget(approvedToolCount(definition));
  const connectors = () => resolveConnectors(definition, connectorTypeContext(dependencies, orgId, async () => githubScope(dependencies, actor.orgId)), dependencies.connectorTypes);
  const respond = (project: Omit<RegisteredProjectRecord, "pk" | "sk">, duplicate: boolean, preflight: PreflightOutcome | undefined) => {
    const warnings = registrationWarnings(budget.warning, preflight);
    return {
      project, duplicate,
      tools: { maximum: budget.maximum, warnAbove: TOOL_WARNING_THRESHOLD, limit: TOOL_LIMIT },
      ...(warnings.length ? { warnings } : {}), ...(preflight ? { preflight: preflight.report } : {}),
      ...(setupApprovalBinding?.decision === "approve" ? { setupRuntime: setupExecutionCreated ? "QUEUED" : "UNAVAILABLE" } : {}),
      ...(ownershipTakenOver ? { ownershipTakenOver: true } : {}),
    };
  };
  const key = projectRevisionKey(orgId, definition.name, definition.revision);
  /**
   * Task AUTH1 (finding N2b): who may store this revision through the operator's admin route. The first revision of a project makes its registrant the administrator; a later
   * revision needs the registrant to administer the project already; an instance administrator who does not can take it over only by asking explicitly, with a reason.
   * Judged against the project as it is now, and again on every attempt, so a registrant who lost a race for the first revision is refused on the next one.
   * MERGE-DECISION: a registration the caller has already authorized (a cloud org's project creation, or its owner's or admin's settings change: creatorMembership "developer" or
   * "none") is not judged here: those callers decide who may register, and a cloud project's people hold project roles, not the operator's administrator row.
   */
  const judgeAuthority = async (newestRevision: number): Promise<"first" | "administrator" | "takeover" | "caller-authorized"> => {
    if (options.creatorMembership !== "administrator") return "caller-authorized";
    if (newestRevision === 0) return "first";
    const authority = await getMembership(dependencies, orgId, actor.ownerKey, definition.name);
    if (authority?.role === "administrator") return "administrator";
    if (takeover !== undefined) return "takeover";
    throw agentXError("FORBIDDEN", `only an administrator of project ${definition.name} can register a new revision of it. An instance administrator who is not one can take the project over by asking explicitly: send takeOwnership: true with a takeOwnershipReason (agentx admin project register --take-ownership --reason "...")`);
  };
  const readCatalogSnapshot = () => readProjectCatalogSnapshot(dependencies, orgId, definition.name);
  const domainWideningFence = (snapshot: Awaited<ReturnType<typeof readCatalogSnapshot>>) => {
    if (dependencies.cloud === true && snapshot.newestRevision > 0
      && isAllowedDomainWidening(snapshot.newestDefinition?.network?.allowedDomains ?? [], definition.network?.allowedDomains ?? [])) refuseAllowedDomainWidening();
  };
  // Legacy registration cannot carry or revalidate reviewed branch selections. Refuse rather than
  // silently discard them; even malformed/present metadata needs its own reviewed migration.
  const selectionFence = async (snapshot: Awaited<ReturnType<typeof readCatalogSnapshot>>): Promise<TransactItems> => {
    if (snapshot.newestRevision === 0) return [];
    const latestKey = projectRevisionKey(orgId, definition.name, snapshot.newestRevision);
    const latest = await getItem<Record<string, unknown>>(dependencies, latestKey);
    if (latest === undefined || Object.hasOwn(latest, "workingBranchSelections")) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "Working branch selections must be preserved or revalidated before registering another project revision.");
    }
    // The Put already fences this item when an identical revision won after our existence read.
    // DynamoDB forbids a second operation on the same item; the conditional winner path handles it.
    if (snapshot.newestRevision === definition.revision) return [];
    return [{ ConditionCheck: { TableName: dependencies.tableName, Key: latestKey,
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(workingBranchSelections)" } }];
  };
  const repairCatalogPointerFromHistory = () => repairProjectCatalogPointerFromHistory(dependencies, orgId, definition.name);
  const requireExpectedBase = (snapshot: Awaited<ReturnType<typeof readCatalogSnapshot>>) => {
    if (options.expectedBaseRevision !== undefined && (!Number.isSafeInteger(options.expectedBaseRevision) || options.expectedBaseRevision < 1
      || definition.revision !== options.expectedBaseRevision + 1 || snapshot.newestRevision !== options.expectedBaseRevision)) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "project changed after its atomic change was planned");
    }
  };
  const existing = await getItem<RegisteredProjectRecord>(dependencies, key);
  if (existing) {
    // Extra transaction effects require their own receipt recovery; matching revision content is insufficient.
    if (options.expectedBaseRevision !== undefined) throw agentXError("PROJECT_REVISION_MISMATCH", "atomic project revision already exists");
    // The stored revision is read back from DynamoDB, which keeps no map's attribute order: compare content, not text.
    if (!sameJsonContent(existing.definition, definition) || !sameJsonContent(existing.runtimeBinding, runtimeBinding) || !sameJsonContent(existing.setupApproval, setupApprovalBinding)) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revisions and runtime bindings are immutable");
    }
    await repairCatalogPointerFromHistory();
    // Plan 4 Task 22: a project registered before the GitHub index existed has no rows; a repeat writes those of its latest revision (whichever revision is repeated).
    await healGithubRepoIndex(dependencies, orgId, definition.name);
    // A revision stored before the static checks existed stays idempotent: report, never refuse.
    const preflight = checked?.preflight
      ?? (wantsPreflight ? await preflightConnectors(connectors(), definition, actor.ownerKey) : undefined);
    return respond(withoutKeys(existing), true, preflight);
  }
  // Refused before any vendor is contacted for a registrant who may not store this revision; the commit judges it again.
  const initialSnapshot = await readCatalogSnapshot();
  await judgeAuthority(initialSnapshot.newestRevision);
  requireExpectedBase(initialSnapshot);
  domainWideningFence(initialSnapshot);
  await selectionFence(initialSnapshot);
  const now = new Date().toISOString();
  const beforeDomains = [...new Set(initialSnapshot.newestDefinition?.network?.allowedDomains ?? [])].sort();
  const afterDomains = [...new Set(definition.network?.allowedDomains ?? [])].sort();
  const commonDomainNarrowing = dependencies.cloud === true && initialSnapshot.newestRevision > 0 && options.expectedBaseRevision === undefined
    && canonicalJson(beforeDomains) !== canonicalJson(afterDomains);
  let commonDomainPlan: Awaited<ReturnType<typeof planLegacyDomainNarrowing>> | undefined;
  if (commonDomainNarrowing) {
    if (definition.revision !== initialSnapshot.newestRevision + 1) throw agentXError("PROJECT_REVISION_MISMATCH", "website narrowing requires the next canonical revision");
    const isOperator = actor.auditActor?.kind === "operator";
    if (isOperator && options.creatorMembership !== "administrator") throw agentXError("FORBIDDEN", "Operator website changes require project registration authority.");
    const authority: TransactItems = isOperator
      ? [{ ConditionCheck: { TableName: dependencies.tableName, Key: orgMetaKey(orgId), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)" } }]
      : await readAllowedDomainActorConditions({ ...dependencies, signInTableName: dependencies.developer?.signInTableName ?? "", now: Date.now }, { orgId, project: definition.name, actorId: actor.ownerKey });
    commonDomainPlan = await planLegacyDomainNarrowing({ ...dependencies, cloud: true, now: () => new Date(now) }, {
      orgId, project: definition.name, by: actor.ownerKey, ...(actor.auditActor === undefined ? {} : { auditActor: actor.auditActor }),
      body: { requestId: randomUUID(), expectedRevision: initialSnapshot.newestRevision, allowedDomains: afterDomains }, before: beforeDomains, after: afterDomains, authority,
    });
  }
  const preflight = await registrationChecks(dependencies, actor, definition, wantsPreflight, options.credentialsChecked);
  const record: RegisteredProjectRecord = {
    ...key,
    entityType: "PROJECT",
    definition,
    runtimeBinding,
    registeredBy: actor.ownerKey,
    registeredAt: now,
    ...(setupApprovalBinding === undefined ? {} : { setupApproval: setupApprovalBinding }),
  };
  // The creator of a project on Rovara Cloud is its first maintainer (Plan 2, Task 21). The operator's own registration keeps its administrator row.
  const membership = options.creatorMembership === "none" ? undefined
    : options.creatorMembership === "administrator" ? membershipRecord(orgId, actor.ownerKey, definition.name, "administrator")
      : membershipRecord(orgId, actor.ownerKey, definition.name, "developer", { projectRole: "maintainer", grantedBy: { developerId: actor.ownerKey }, grantedAt: now });
  const metaKey = projectMetaKey(orgId, definition.name);
  const metaItem = {
    ...metaKey, entityType: "PROJECT_META", name: definition.name, status: "active",
    ...(options.description === undefined ? {} : { description: options.description }),
    createdAt: now, createdBy: actor.ownerKey,
  };
  const membershipKey = membership === undefined ? undefined : { pk: membership.pk, sk: membership.sk };
  const setupAdmissionRows = setupRuntimeAdmission && setupApprovalBinding?.decision === "approve" && definition.e2e !== undefined
    ? await createProjectSetupAdmissionRows(dependencies, { ...actor, auditActor: actor.auditActor ?? auditActorOf(actor.ownerKey) }, record, setupApprovalBinding, setupRuntimeAdmission)
    : undefined;
  setupExecutionCreated = setupAdmissionRows !== undefined;
  await ensureInstallOrg(dependencies, orgId);
  // Owner decision D5 (Task 3.1): registering the setup is the step that makes it effective, so it registers the project's synthetic test accounts too, in the transaction
  // that stores the revision. The setup is the one this registration binds (the registering administrator's own approved proposal for this project), never another.
  const registerAccounts = setupApprovalBinding?.decision === "approve" && definition.e2e !== undefined && setupApprovedAt !== "";
  let accountSetup: { snapshot: E2ESourceSnapshot; approvedAt: string; proposalSha256: string } | undefined;
  if (registerAccounts) {
    const repository = definition.repositories[0]!;
    const repositoryParts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(repository.url);
    const setup = await readApprovedSetupSource(dependencies, record, E2EPolicySchema.parse(definition.e2e), repository,
      repositoryParts?.[1] && repositoryParts[2] ? `${repositoryParts[1]}/${repositoryParts[2]}` : undefined);
    if (!setup.ok) throw agentXError("PROJECT_REVISION_MISMATCH", `the approved setup could not be read to register the project's test accounts: ${setup.reason}`);
    accountSetup = { snapshot: setup.snapshot, approvedAt: setupApprovedAt, proposalSha256: setupApprovalBinding!.proposalSha256 };
  }
  const planAccounts = async () => {
    if (accountSetup === undefined) return { items: [] as TransactItems, written: 0, planKey: "" };
    try { return await planSetupAccountWrites(dependencies, { orgId, projectId: definition.name, snapshot: accountSetup.snapshot, setup: accountSetup, now: Date.now() }); }
    catch (error) {
      if (error instanceof E2EAccountRegistryError) throw agentXError("PROJECT_REVISION_MISMATCH", error.message);
      throw error;
    }
  };
  const initialDomainPlan = dependencies.cloud === true && initialSnapshot.newestRevision === 0 && (definition.network?.allowedDomains.length ?? 0) > 0
    ? await planInitialProjectDomains(dependencies, { orgId, project: definition.name, actorId: actor.ownerKey, actor: actor.auditActor ?? auditActorOf(actor.ownerKey),
      revision: definition.revision, domains: definition.network!.allowedDomains, at: now }) : undefined;
  const maxRegistrationAttempts = 3;
  for (let attempt = 0; attempt < maxRegistrationAttempts; attempt += 1) {
    const snapshot = await readCatalogSnapshot();
    requireExpectedBase(snapshot);
    if (commonDomainPlan !== undefined && snapshot.newestRevision !== initialSnapshot.newestRevision) throw agentXError("PROJECT_REVISION_MISMATCH", "website plan lost its canonical base");
    if (initialDomainPlan !== undefined && snapshot.newestRevision !== 0) throw agentXError("PROJECT_REVISION_MISMATCH", "initial website plan requires a new project");
    const latestRevision = Math.max(definition.revision, snapshot.newestRevision);
    const updateCatalog = snapshot.catalog?.latestRevision !== latestRevision;
    // Plan 4 Task 21: GitHub's events find this project by each pinned repository's id. The rows are written with the revision that pins the repository (a repeat heals a missing one)
    // and deleted by the one that no longer holds it, in the same transaction, so no revision leaves the index behind it.
    const pinned = (repositories: ProjectDefinition["repositories"]) => new Map(repositories.flatMap((repository) => repository.installationId === undefined || repository.githubRepositoryId === undefined ? [] : [[repository.githubRepositoryId, repository.installationId] as const]));
    const holds = pinned(definition.repositories);
    // Only the project's latest revision may change its rows: an older one registered late (after a newer one) leaves them as the newer one made them.
    const repositoryIndex = definition.revision < snapshot.newestRevision ? [] : [
      ...[...holds].map(([githubRepositoryId, installationId]) => ({ Put: { TableName: dependencies.tableName, Item: {
        ...githubRepoProjectKey(githubRepositoryId, orgId, definition.name), entityType: "GITHUB_REPO_PROJECT", orgId, project: definition.name, installationId, githubRepositoryId,
      } } })),
      ...[...pinned(snapshot.newestRepositories).keys()].filter((githubRepositoryId) => !holds.has(githubRepositoryId)).map((githubRepositoryId) => ({ Delete: { TableName: dependencies.tableName, Key: githubRepoProjectKey(githubRepositoryId, orgId, definition.name) } })),
    ];
    // An existing project changes (its test accounts included) only at the hand of one of its administrators, or of an instance administrator who takes it over explicitly.
    // Judged against the project as it is on this attempt: an administrator who raced a first registration and lost finds the project there on the next one.
    const authority = await judgeAuthority(snapshot.newestRevision);
    domainWideningFence(snapshot);
    const selectionsAbsent = await selectionFence(snapshot);
    const accounts = await planAccounts();
    const previousCreatorGrant = membership === undefined || authority === "administrator" ? undefined : await getMembership(dependencies, orgId, actor.ownerKey, definition.name);
    const membershipGeneration = membership === undefined || authority === "administrator" ? []
      : await approvalGrantChange({ ...dependencies, now: () => new Date(now) }, orgId, definition.name,
        previousCreatorGrant?.projectRole === "maintainer" && membership.projectRole !== "maintainer");
    // H6: the models, checks and E2E capture this revision changes against the newest one are audited in this transaction. A revision registered late (older than the newest) changes nothing the project runs.
    const audit = definition.revision < snapshot.newestRevision ? { items: [] as TransactItems, events: [] as AuditEventInput[] } : await auditedWrite(dependencies, () => projectDefinitionAuditEvents({
      orgId, actor: actor.auditActor ?? auditActorOf(actor.ownerKey), occurredAt: now, before: snapshot.newestDefinition, after: definition,
    }));
    // One transaction holds at most 100 items; the project revision, its membership, the catalog and the setup admission take the rest.
    if (accounts.items.length > 60) throw agentXError("CONFIG_INVALID", "the setup declares more synthetic test accounts than one registration can store");
    try {
      // DynamoDB allows one action per item. Keep the narrowing snapshot AND
    // eligibility-loss fence when a takeover updates that same META row.
    const commonDomainItems = commonDomainPlan?.items.filter(item => {
      const check = item.ConditionCheck;if (check === undefined) return true;
      const update = membershipGeneration.find(generation => generation.Update?.TableName === check.TableName
        && generation.Update?.Key?.pk === check.Key?.pk && generation.Update?.Key?.sk === check.Key?.sk)?.Update;
      if (update === undefined) return true;
      for (const [token, value] of Object.entries(check.ExpressionAttributeNames ?? {})) {
        if (update.ExpressionAttributeNames?.[token] !== undefined && update.ExpressionAttributeNames[token] !== value) throw agentXError("CONFIG_INVALID", "Website transaction condition conflicts.");
      }
      for (const [token, value] of Object.entries(check.ExpressionAttributeValues ?? {})) {
        if (update.ExpressionAttributeValues?.[token] !== undefined && canonicalJson(update.ExpressionAttributeValues[token]) !== canonicalJson(value)) throw agentXError("CONFIG_INVALID", "Website transaction condition conflicts.");
      }
      update.ConditionExpression = [update.ConditionExpression, check.ConditionExpression].filter(Boolean).join(" AND ");
      if (check.ExpressionAttributeNames !== undefined) update.ExpressionAttributeNames = { ...update.ExpressionAttributeNames, ...check.ExpressionAttributeNames };
      if (check.ExpressionAttributeValues !== undefined) update.ExpressionAttributeValues = { ...update.ExpressionAttributeValues, ...check.ExpressionAttributeValues };
      return false;
    }) ?? [];
    const projectSpendingItems: TransactItems = [];
    if (snapshot.catalog === undefined && snapshot.newestRevision === 0) {
      const policyKey = orgSettingsKey(orgId, "TASK_STOP_POLICY");
      const policy = (await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: policyKey, ConsistentRead: true }))).Item;
      // An unenrolled company keeps the existing registration and settings shape.
      // Explicit upgrade inventories prepare inheritance before enrollment.
      const enrollment = z.object({ version: z.literal(1), state: z.literal("enabled") }).safeParse(policy?.enrollment);
      if (policy?.entityType === "ORG_TASK_STOP_POLICY" && policy.orgId === orgId && enrollment.success) {
        const key = projectAiKey(orgId, definition.name);
        const existing = (await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: key, ConsistentRead: true }))).Item;
        projectSpendingItems.push(...nativeSnapshotConditions(dependencies.tableName, [policyKey], [policy], ["enrollment"]), ...(existing === undefined ? taskStopProjectCreationItems(dependencies.tableName, orgId, definition.name, Date.parse(now)) : nativeSnapshotConditions(dependencies.tableName, [key], [existing], ["taskStopPolicy"])));
      } else if (policy !== undefined) {
        // No new item while off; a cutover after this read retries registration on the enabled path.
        const policySource = policy as Record<string, unknown>;
        const enrollmentSource = { ...policyKey, orgId: policySource.orgId, entityType: policySource.entityType, enrollment: policySource.enrollment };
        projectSpendingItems.push(...nativeSnapshotConditions(dependencies.tableName, [policyKey], [enrollmentSource], ["enrollment"]));
      }
    }
    const registrationItems: TransactItems = [
      { Put: { TableName: dependencies.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" } },
      // The operator's first registration and a takeover write the registrant's administrator membership; an administrator's own is left as it is (its grant is not reissued)
      // but must still hold when the revision commits. A registration the caller authorized writes the creator's grant (or none), as it always did.
      ...(authority === "administrator" && membershipKey !== undefined
        ? [{ ConditionCheck: { TableName: dependencies.tableName, Key: membershipKey, ConditionExpression: "#role = :administrator",
          ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":administrator": "administrator" } } }]
        : membership === undefined ? [] : [{ Put: { TableName: dependencies.tableName, Item: membership } }]),
      ...(authority === "takeover" && takeover !== undefined ? [{ Put: { TableName: dependencies.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        pk: orgScoped(orgId, `PROJECT_TAKEOVER#${definition.name}`), sk: `AT#${now}#${randomUUID()}`, entityType: "PROJECT_OWNERSHIP_TAKEOVER",
        projectName: definition.name, revision: definition.revision, takenBy: actor.ownerKey, subject: actor.subject, orgId, reason: takeover.reason, at: now,
      } } }] : []),
      // Only a project new to the org gets a META item; a revision of an existing one leaves its META alone.
      ...(options.requireNewName === true ? [{ Put: { TableName: dependencies.tableName, Item: metaItem, ConditionExpression: "attribute_not_exists(pk)" } }]
        : snapshot.catalog === undefined && snapshot.newestRevision === 0 ? [{ Update: {
          TableName: dependencies.tableName, Key: metaKey,
          UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), #name = if_not_exists(#name, :name), #status = if_not_exists(#status, :status), createdAt = if_not_exists(createdAt, :now), createdBy = if_not_exists(createdBy, :by)"
            + (options.description === undefined ? "" : ", description = if_not_exists(description, :description)"),
          ExpressionAttributeNames: { "#name": "name", "#status": "status" },
          ExpressionAttributeValues: { ":entity": "PROJECT_META", ":name": definition.name, ":status": "active", ":now": now, ":by": actor.ownerKey,
            ...(options.description === undefined ? {} : { ":description": options.description }) },
        } }] : []),
      // Spec 025 A3: the admin project list reads this row instead of scanning the table.
      ...(updateCatalog ? [{ Update: {
        TableName: dependencies.tableName,
        Key: orgProjectCatalogKey(orgId, definition.name),
        UpdateExpression: "SET entityType = :entity, #name = :name, latestRevision = :revision, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now), orgId = if_not_exists(orgId, :spendingOrg)",
        ConditionExpression: snapshot.catalog === undefined ? "attribute_not_exists(pk)"
          : snapshot.catalog.latestRevision === undefined ? "attribute_not_exists(latestRevision)"
            : "latestRevision = :observed AND latestRevision < :revision",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": definition.name, ":revision": latestRevision, ":now": now, ":spendingOrg": orgId,
          ...(snapshot.catalog?.latestRevision === undefined ? {} : { ":observed": snapshot.catalog.latestRevision }) },
      } }] : []),
      // A late older revision does not update the catalog, but must still observe its same pointer.
      ...(!updateCatalog && snapshot.catalog?.latestRevision !== undefined ? [{ ConditionCheck: {
        TableName: dependencies.tableName, Key: orgProjectCatalogKey(orgId, definition.name),
        ConditionExpression: "latestRevision = :observed", ExpressionAttributeValues: { ":observed": snapshot.catalog.latestRevision },
      } }] : []),
      ...selectionsAbsent,
      ...(setupAdmissionRows?.transactionItems ?? []),
      ...accounts.items,
      ...repositoryIndex,
      ...projectSpendingItems,
      // The caller's own writes that must land with the project (Task 16: the creation request's record), after every item above.
      ...(options.extraItems ?? []),
      ...membershipGeneration,
      ...(initialDomainPlan?.items ?? []),
      ...commonDomainItems,
      ...audit.items,
      ];
      if (registrationItems.length > 100) throw agentXError("CONFIG_INVALID", "This project change cannot fit one transaction.");
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: registrationItems }));
      await flushAuditEvents(dependencies, [...audit.events, ...projectSpendingItems.flatMap(item => item.Put?.Item?.event === undefined ? [] : [AuditEventInputSchema.parse(item.Put.Item.event)]), ...(initialDomainPlan === undefined ? [] : [initialDomainPlan.event]), ...(commonDomainPlan === undefined ? [] : [commonDomainPlan.event])]);
      if (authority === "takeover") {
        ownershipTakenOver = true;
        console.log(JSON.stringify({ component: "broker", event: "project.ownership_taken_over", project: definition.name, revision: definition.revision, takenBy: actor.ownerKey }));
      }
      return respond(withoutKeys(record), false, preflight);
    } catch (error) {
      await rethrowAsDeferredIfHeld(dependencies, error, Date.now()); // AUTOREQUALIFY: the start fence refused the setup run: say so, not "catalog conflict"
      if (!isConditional(error)) throw error;
      // Another request took the name between the read above and this commit.
      if (options.requireNewName === true) {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
        const failed = (index: number) => reasons?.[index]?.Code === "ConditionalCheckFailed";
        // The name is taken only when the revision, META or catalog item's own condition failed. Items sit in this order: revision,
        // the grant (if any), META, the catalog update (if any), then the setup rows.
        const metaIndex = membership === undefined ? 1 : 2;
        if (failed(0) || failed(metaIndex) || (updateCatalog && failed(metaIndex + 1))) {
          throw agentXError("PROJECT_NAME_TAKEN", projectNameTakenMessage(definition.name));
        }
        // A transaction that only met another in flight says nothing about the name: the caller tries again.
        if (reasons?.some((reason) => reason?.Code === "TransactionConflict")) {
          throw agentXError("RUNTIME_UNAVAILABLE", "another change to this organization's projects was in progress; try again in a moment");
        }
        // Anything else (a setup row's condition) is handled as it is without requireNewName, below.
      }
      // A composed authority/egress/receipt plan is single-attempt. Never replan or
      // report another writer's same-content revision as this transaction's success.
      if (options.expectedBaseRevision !== undefined || initialDomainPlan !== undefined || commonDomainPlan !== undefined) throw agentXError("PROJECT_REVISION_MISMATCH", "atomic project change lost its original conditions");
      // A same-revision registration may have won concurrently. Validate the immutable record and
      // catalog before returning duplicate success; otherwise retry only a catalog/history advance.
      const winner = await getItem<RegisteredProjectRecord>(dependencies, key);
      if (winner !== undefined && options.requireNewName === true) {
        throw agentXError("PROJECT_NAME_TAKEN", projectNameTakenMessage(definition.name));
      }
      if (winner !== undefined) {
        if (!sameJsonContent(winner.definition, definition) || !sameJsonContent(winner.runtimeBinding, runtimeBinding)
          || !sameJsonContent(winner.setupApproval, setupApprovalBinding)) {
          throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revisions and runtime bindings are immutable");
        }
        await repairCatalogPointerFromHistory();
        return respond(withoutKeys(winner), true, preflight);
      }
      const refreshed = await readCatalogSnapshot();
      const advanced = refreshed.newestRevision > snapshot.newestRevision
        || (refreshed.catalog?.latestRevision ?? 0) > (snapshot.catalog?.latestRevision ?? 0);
      // Another registration may have moved an account under this one: plan again (a stale setup is refused then) rather than give up.
      const accountsMoved = accountSetup !== undefined && (await planAccounts()).planKey !== accounts.planKey;
      // The registrant's standing may have changed under this attempt (the membership removed or downgraded outside the API, the project registered by a rival): refused here, not as a catalog conflict.
      const authorityMoved = (await judgeAuthority(refreshed.newestRevision)) !== authority;
      if ((!advanced && !accountsMoved && !authorityMoved) || attempt + 1 === maxRegistrationAttempts) {
        throw agentXError("PROJECT_REVISION_MISMATCH", "project revision registration could not commit against the current catalog");
      }
    }
  }
  throw agentXError("PROJECT_REVISION_MISMATCH", "project revision registration exceeded its bounded catalog retries");
}

/** What a tenant is told of a project it created: no runtime binding (the shared foundation's launch template and subnets) and no credential reference. */
export type CloudProjectCreated = { duplicate: boolean; project: { definition: Omit<ProjectDefinition, "repositories"> & { repositories: Array<Pick<ProjectDefinition["repositories"][number], "name" | "url" | "path" | "defaultBranch">> }; registeredAt: string }; warnings?: string[] };

function cloudProjectAnswer(registered: RegistrationResult): CloudProjectCreated {
  const { definition } = registered.project;
  return {
    duplicate: registered.duplicate,
    project: {
      definition: { ...definition, repositories: definition.repositories.map(({ name, url, path, defaultBranch }) => ({ name, url, path, defaultBranch })) },
      registeredAt: registered.project.registeredAt,
    },
    ...(registered.warnings === undefined ? {} : { warnings: registered.warnings }),
  };
}

const PROJECT_CREATE_REQUEST_SECONDS = 86_400;

/** A request body's identity for a replay: the repository without regard to case, and the other fields as given. */
function projectCreateBodyHash(input: CreateProjectInput): string {
  return createHash("sha256").update(canonicalJson({
    repository: `${input.owner}/${input.repositoryName}`.toLowerCase(),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    // One command is hashed as the single field it always was, so a retry of a request made before lists existed is still the same request.
    ...(input.setupCommands === undefined ? {} : input.setupCommands.length === 1 ? { setupCommand: input.setupCommands[0] } : { setupCommands: input.setupCommands }),
    ...(input.testCommands === undefined ? {} : input.testCommands.length === 1 ? { testCommand: input.testCommands[0] } : { testCommands: input.testCommands }),
  }), "utf8").digest("hex");
}

/**
 * What a failed read of GitHub means to the person who asked for a repository: a redirect (a renamed or transferred repository, which the
 * lookup refuses with `redirect: "error"`) is theirs to fix, a network failure is not. Node's fetch rejects both with TypeError("fetch failed")
 * and tells them apart by the cause; any other error is passed on as it is.
 */
function githubReadFailure(error: unknown, owner: string, name: string): never {
  if (error instanceof TypeError) {
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    if (cause === "unexpected redirect") throw agentXError("CONFIG_INVALID", `GitHub moved or renamed ${owner}/${name}; use its current owner/name`);
    if (error.message === "fetch failed") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub could not be reached just now; try again in a moment");
  }
  throw error;
}

/**
 * The project an earlier identical creation request made, as that request was answered (`duplicate: true`), or undefined when no unexpired
 * record of the request exists. The same request id with another body is IDEMPOTENCY_CONFLICT. A record past its day is no record: the id
 * is free again (the creation's transaction replaces it).
 */
async function replayedProjectCreation(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  requestKey: { pk: string; sk: string },
  bodyHash: string,
  actorId: string,
  nowMs: number,
): Promise<CloudProjectCreated | undefined> {
  const recorded = await getItem<{ bodyHash?: unknown; projectName?: unknown; expiresAt?: unknown; by?: unknown }>(dependencies, requestKey);
  if (recorded === undefined || typeof recorded.expiresAt !== "number" || recorded.expiresAt < Math.floor(nowMs / 1000) || typeof recorded.projectName !== "string") return undefined;
  // The one request-id pattern (final review M2): the record is the caller's, and says the same body. Another person of the org can neither replay it nor learn the project.
  requireSameRequest(recorded, { by: actorId, bodyHash }, "this requestId was already used to create a different project");
  const made = await getItem<RegisteredProjectRecord>(dependencies, projectRevisionKey(orgId, recorded.projectName, 1));
  return made === undefined ? undefined : cloudProjectAnswer({ project: withoutKeys(made), duplicate: true });
}

/**
 * Plan 2, Task 16: `POST /v1/app/projects`, after the route has checked the install, the caller's role and the body.
 *
 * Order: a replay of the request (the same `requestId` and body answers the project it made; another body is IDEMPOTENCY_CONFLICT), whether the
 * org's own GitHub connection reaches the repository (`requireRepositoryConnected`: the installation GitHub says covers it must be bound to the
 * org and active), GitHub's own description of the repository, the registration as a new name in the org (`registerProjectFor`), which writes
 * the project, its META, the caller's grant and the request's record in one transaction. The revision's repository entry pins the installation
 * and GitHub's repository id.
 */
export async function createCloudProject(dependencies: AwsBrokerDependencies, caller: DeveloperCaller, input: CreateProjectInput): Promise<CloudProjectCreated> {
  const orgId = caller.orgId;
  const requestKey = projectCreateRequestKey(orgId, input.requestId);
  const bodyHash = projectCreateBodyHash(input);
  const nowMs = Date.now();
  const replayed = () => replayedProjectCreation(dependencies, orgId, requestKey, bodyHash, caller.developerId, nowMs);
  const earlier = await replayed();
  if (earlier !== undefined) return earlier;
  const defaults = dependencies.cloudProjects;
  const lookUp = dependencies.githubPullRequests.getRepositoryIdentity;
  const gate = repositoryGateOf(dependencies);
  if (defaults === undefined || lookUp === undefined || gate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "creating projects is not set up in this deployment; ask Rovara support");
  const { owner, repositoryName } = input;
  const connection = await requireRepositoryConnected(gate, orgId, owner, repositoryName).catch((error: unknown) => githubReadFailure(error, owner, repositoryName));
  const identity = await lookUp.call(dependencies.githubPullRequests, `https://github.com/${owner}/${repositoryName}.git`, githubScope(dependencies, orgId)).catch((error: unknown) => githubReadFailure(error, owner, repositoryName));
  if (identity === undefined) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(`${owner}/${repositoryName}`));
  // The pin is the id the connection was checked for: a repository deleted and recreated between the two reads is not that repository.
  if (identity.repositoryId !== connection.githubRepositoryId) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub described ${owner}/${repositoryName} differently a moment ago; try again`);
  const spelledOwner = identity.fullName.split("/")[0];
  if (spelledOwner === undefined || identity.defaultBranch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not describe that repository; try again");
  // GitHub's spelling of the owner is the one the connection was checked for (a renamed owner would have redirected, which is refused above).
  if (spelledOwner.toLowerCase() !== owner.toLowerCase()) throw agentXError("FORBIDDEN", `GitHub describes ${owner}/${repositoryName} under ${spelledOwner}; use its current owner/name`);
  const definition = cloudProjectDefinition({ input, repository: { fullName: identity.fullName, defaultBranch: identity.defaultBranch }, githubCredentialRef: defaults.githubCredentialRef, connection });
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = Math.floor(nowMs / 1000) + PROJECT_CREATE_REQUEST_SECONDS;
  let registered: RegistrationResult;
  try {
    registered = await registerProjectFor(
      dependencies,
      { orgId, ownerKey: caller.developerId },
      { definition, runtimeBinding: defaults.runtimeBinding },
      {
        creatorMembership: "developer", requireNewName: true, ...(input.description === undefined ? {} : { description: input.description }),
        extraItems: [{ Put: {
          TableName: dependencies.tableName,
          // `indexExpiresAt` is the State table's TTL attribute: the record goes when its day is over.
          Item: { ...requestKey, entityType: "PROJECT_CREATE_REQUEST", by: caller.developerId, bodyHash, projectName: definition.name, createdAt, expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": Math.floor(nowMs / 1000) },
        } }],
      },
    );
  } catch (error) {
    // An identical request in flight may have won the name a moment ago: its record is then there, and this one answers the same project.
    if (error instanceof AgentXError && error.code === "PROJECT_NAME_TAKEN") {
      const raced = await replayed();
      if (raced !== undefined) return raced;
    }
    throw error;
  }
  console.log(JSON.stringify({ component: "broker", event: "developer.project_created", orgId, project: definition.name, duplicate: registered.duplicate }));
  return cloudProjectAnswer(registered);
}

async function readProjectCatalogSnapshot(dependencies: AwsBrokerDependencies, orgId: OrgId, projectName: string): Promise<{ catalog: { entityType?: string; name?: string; latestRevision?: number } | undefined; newestRevision: number; newestRepositories: ProjectDefinition["repositories"]; newestDefinition?: ProjectDefinition }> {
  const catalog = await getItem<{ entityType?: string; name?: string; latestRevision?: number }>(dependencies, orgProjectCatalogKey(orgId, projectName));
  if (catalog !== undefined && (catalog.entityType !== "PROJECT_CATALOG" || catalog.name !== projectName
    || (catalog.latestRevision !== undefined && (!Number.isSafeInteger(catalog.latestRevision) || catalog.latestRevision < 1)))) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog is unavailable or invalid");
  }
  let newestRevision = 0;
  let newestRepositories: ProjectDefinition["repositories"] = [];
  let newestDefinition: ProjectDefinition | undefined;
  try {
    const newest = await requireLatestProject(dependencies, orgId, projectName);
    newestRevision = newest.definition.revision;
    newestRepositories = newest.definition.repositories;
    newestDefinition = newest.definition;
    if (newest.definition.name !== projectName || !Number.isSafeInteger(newestRevision) || newestRevision < 1) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revision history is invalid");
    }
  } catch (error) {
    if (!(error instanceof AgentXError) || error.code !== "NOT_FOUND") throw error;
  }
  if (catalog?.latestRevision !== undefined && catalog.latestRevision > newestRevision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog is ahead of registered revision history");
  }
  return { catalog, newestRevision, newestRepositories, ...(newestDefinition === undefined ? {} : { newestDefinition }) };
}

async function repairProjectCatalogPointerFromHistory(dependencies: AwsBrokerDependencies, orgId: OrgId, projectName: string, options: { createCatalogRow?: boolean } = {}): Promise<void> {
  // This is an index-only repair after the immutable revision has already been
  // authenticated. It never rewrites project, membership, approval, or setup rows.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await readProjectCatalogSnapshot(dependencies, orgId, projectName);
    const targetRevision = snapshot.newestRevision;
    if (targetRevision < 1) throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revision history is unavailable");
    if (snapshot.catalog === undefined && options.createCatalogRow === false) throw agentXError("PROJECT_REVISION_MISMATCH", "catalog-row-absent");
    if (snapshot.catalog?.latestRevision === targetRevision) return;
    const key = orgProjectCatalogKey(orgId, projectName);
    try {
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName,
        Key: key,
        UpdateExpression: "SET entityType = :entity, #name = :name, latestRevision = :revision, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)",
        ConditionExpression: snapshot.catalog === undefined ? "attribute_not_exists(pk)"
          : snapshot.catalog.latestRevision === undefined
            ? "entityType = :entity AND #name = :name AND attribute_not_exists(latestRevision)"
            : "entityType = :entity AND #name = :name AND latestRevision = :observed AND latestRevision < :revision",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": projectName, ":revision": targetRevision,
          ":now": new Date().toISOString(),
          ...(snapshot.catalog?.latestRevision === undefined ? {} : { ":observed": snapshot.catalog.latestRevision }) },
      }));
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
      if (attempt === 2) throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog pointer could not be reconciled with immutable revision history");
      const refreshed = await readProjectCatalogSnapshot(dependencies, orgId, projectName);
      if (refreshed.newestRevision <= snapshot.newestRevision
        && (refreshed.catalog?.latestRevision ?? 0) <= (snapshot.catalog?.latestRevision ?? 0)) {
        throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog pointer changed without revision history advancing");
      }
    }
  }
}

/**
 * Publication authority guards the project's catalog row with `latestRevision = :latest`. Rows written before the
 * catalog pointer existed have no `latestRevision`, and the guard can never hold for them. Before such a guard is
 * built, the pointer is repaired from the immutable revision history by the same index-only repair registration
 * uses (conditional on the attribute still being absent). It repairs a row that exists; it never creates one. A project
 * whose catalog row is absent, or whose history is missing or ambiguous, is refused with CONFIG_INVALID (never as a busy
 * workspace): the owner hears PROJECT_RECORD_NEEDS_ADMIN, and the broker log names the project and the reason. A catalog
 * row that already has its pointer is left alone. The E2E current-authority check also runs this when a task or Slack
 * card is presented, so a legacy project's first view writes the (index-only, conditional) pointer.
 */
export async function ensureProjectCatalogPointer(dependencies: AwsBrokerDependencies, orgId: OrgId, projectName: string): Promise<void> {
  const catalog = await getItem<{ latestRevision?: unknown }>(dependencies, orgProjectCatalogKey(orgId, projectName));
  if (catalog?.latestRevision !== undefined) return;
  const refuse = (reason: string): never => {
    console.log(JSON.stringify({ component: "broker", event: "project.catalog_pointer_unrepairable", project: projectName, reason }));
    throw agentXError("CONFIG_INVALID", PROJECT_RECORD_NEEDS_ADMIN);
  };
  if (catalog === undefined) return refuse("catalog-row-absent");
  try {
    await repairProjectCatalogPointerFromHistory(dependencies, orgId, projectName, { createCatalogRow: false });
  } catch (error) {
    if (!(error instanceof AgentXError) || error.code !== "PROJECT_REVISION_MISMATCH") throw error;
    return refuse(error.message.replace(/^PROJECT_REVISION_MISMATCH: /u, ""));
  }
}

async function createProjectSetupAdmissionRows(
  dependencies: AwsBrokerDependencies,
  identity: Pick<AuthenticatedIdentity, "ownerKey" | "orgId"> & { auditActor: AuditActor },
  project: RegisteredProjectRecord,
  setupApproval: NonNullable<RegisteredProjectRecord["setupApproval"]>,
  runtime: NonNullable<ReturnType<typeof admitProjectSetupRuntime>>,
  retry?: { attemptId: string; retryOfExecutionId: string },
): Promise<{ transactionItems: Array<Record<string, unknown>> } | undefined> {
  if (!dependencies.projectSetupRuntimeCatalogId || project.runtimeBinding.deploymentMode !== "ec2-ebs") return undefined;
  await requirePricedTaskStopAdmission(dependencies, { orgId: identity.orgId, actor: identity.auditActor, workKind: "admin-setup-execution" });
  const endpoint = new URL(runtime.endpoint);
  if (endpoint.protocol !== "http:" || !z.ipv4().safeParse(endpoint.hostname).success) return undefined;
  const approval = await getItem<Record<string, unknown>>(dependencies, projectSetupApprovalKey(requireOrgId(identity.orgId), project.definition.name, setupApproval.proposalSha256));
  if (!approval || approval.ownerKey !== identity.ownerKey || approval.decision !== "approve" || approval.proposalRef !== setupApproval.proposalRef
    || typeof approval.policyDigest !== "string" || !sameJsonContent(approval.policy, project.definition.e2e)) return undefined;
  const stored = await readStoredText(dependencies.s3, dependencies.artifactBucketName, setupApproval.proposalRef, MAX_SETUP_PROPOSAL_BYTES);
  if (!stored || createHash("sha256").update(stored, "utf8").digest("hex") !== setupApproval.proposalSha256) return undefined;
  let artifact: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(stored);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
    artifact = decoded as Record<string, unknown>;
  } catch { return undefined; }
  if (artifact.schemaVersion !== "project-setup-source-proposal/v1" || artifact.issuerOwnerKey !== identity.ownerKey
    || !artifact.snapshot || typeof artifact.snapshot !== "object" || Array.isArray(artifact.snapshot)) return undefined;
  const rawSnapshot = artifact.snapshot as Record<string, unknown>;
  if (!Array.isArray(rawSnapshot.sources)) return undefined;
  let snapshot: E2ESourceSnapshot;
  try {
    snapshot = { ...rawSnapshot, sources: rawSnapshot.sources.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid source record");
      const source = raw as Record<string, unknown>;
      if (typeof source.path !== "string" || typeof source.sha256 !== "string" || typeof source.bytesBase64 !== "string" || source.kind !== "blob") throw new Error("invalid source record");
      return { path: source.path, sha256: source.sha256, bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const };
    }) } as unknown as E2ESourceSnapshot;
    verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  } catch { return undefined; }
  const policy = E2EPolicySchema.safeParse(project.definition.e2e);
  if (!policy.success) return undefined;
  let derived: ReturnType<typeof deriveProjectSetupSourceSmoke>;
  try {
    derived = deriveProjectSetupSourceSmoke({
      projectName: project.definition.name, proposalSha256: setupApproval.proposalSha256,
      approval: { proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256, candidateDigest: setupApproval.candidateDigest,
        policyDigest: approval.policyDigest, runtimeCatalogId: runtime.runtimeCatalogId, catalogRevision: runtime.catalogRevision,
        bindingDigest: runtime.bindingDigest, manifestDigest: runtime.manifestDigest, generation: runtime.generation },
      snapshot, policy: policy.data,
      sandboxAvailability: { targetId: "default-sandbox", profileId: policy.data.defaultSandboxProfileId, connection: "connected", approval: "approved",
        qualification: "qualified", authorizationRevision: `catalog-${runtime.catalogRevision}` },
      runtimeAvailability: [],
    });
  } catch { return undefined; }

  const now = new Date();
  const stableUuid = (label: string) => {
    const stableInput = retry
      ? `project-setup/retry/v1\0${retry.retryOfExecutionId}\0${retry.attemptId}\0${identity.ownerKey}\0${project.definition.name}\0${project.definition.revision}\0${setupApproval.proposalSha256}\0${runtime.generation}\0${label}`
      : `project-setup/v1\0${identity.ownerKey}\0${project.definition.name}\0${project.definition.revision}\0${setupApproval.proposalSha256}\0${runtime.generation}\0${label}`;
    const bytes = createHash("sha256").update(stableInput).digest().subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const setupExecutionId = stableUuid("execution");
  const subjectId = stableUuid("subject");
  // This is the exact server-configured worker identity from the ready registry, never a caller
  // supplied workspace id or a value inferred from the setup execution.
  const transportCorrelationId = runtime.transportCorrelationId;
  const operationId = stableUuid("operation");
  const outboxId = stableUuid("outbox");
  const fence = 1;
  let setupRunContext: Record<string, unknown>;
  let evidenceByteLimit: number;
  try {
    const plan = selectE2EExecutionPlan(derived.selectionInput);
    if (plan.groups.length === 0 || plan.groups.some((group) => group.expectedCases.length === 0)) return undefined;
    const bundleBody = { schemaVersion: 1 as const, planDigest: derived.planDigest, templateVersion: "trusted-e2e/v1", scenarios: derived.scenarios, bundleDigest: "0".repeat(64) };
    const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
    const compiledGroups = plan.groups.map((group) => ({ group, compiled: compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput: derived.selectionInput, executionPlan: plan, group }) }));
    const totalCases = compiledGroups.reduce((total, item) => total + item.group.expectedCases.length, 0);
    evidenceByteLimit = e2ePrivateTransferMaxBytes(totalCases, compiledGroups.length);
    const roundId = stableUuid("round");
    const admittedAt = now.toISOString();
    const deadlineAt = new Date(now.getTime() + policy.data.limits.runTimeoutMs).toISOString();
    const taskId = `project-setup:${setupExecutionId}`;
    const groupAdmissions = compiledGroups.map(({ group, compiled }, index) => {
      const runId = stableUuid(`run-${index}-${group.groupId}`);
      const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId, roundId, taskId, operationId, operationFence: fence,
        workflowRevision: project.definition.revision, groupId: group.groupId, executionPlanDigest: plan.digest, executionMode: group.mode,
        mockManifestDigest: group.mockManifestDigest, authorizationRevision: `setup:${1}`, candidateDigest: setupApproval.candidateDigest,
        planDigest: derived.planDigest, policyDigest: approval.policyDigest, bundleDigest: bundle.bundleDigest,
        appBuildDigest: createHash("sha256").update(canonicalJson(compiled.inventory)).digest("hex"),
        environmentDigest: createHash("sha256").update(canonicalJson(runtime.runnerEnvironment), "utf8").digest("hex"), runtimeManifestDigest: runtime.manifestDigest,
        modelRouteRevision: null, expectedCases: compiled.expectedCases, admittedAt, deadlineAt });
      return { group, binding, expectedConfigDigest: compiled.expectedConfigDigest, compiledInventoryDigest: compiled.inventory.digest,
        expectedCases: compiled.expectedCases, selectionPacketPath: compiled.selectionPacketPath };
    });
    const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId, operationId, operationFence: fence,
      workflowRevision: project.definition.revision, executionPlanDigest: plan.digest, admittedAt, deadlineAt,
      limits: policy.data.limits, groupBindings: groupAdmissions.map((item) => item.binding) });
    setupRunContext = { roundId, admittedAt, deadlineAt, runnerEnvironment: runtime.runnerEnvironment,
      runnerToolchain: runtime.runnerToolchain, runnerToolchainDigest: runtime.runnerToolchainDigest, plan, bundle, round, groupAdmissions };
  } catch { return undefined; }
  const executionObject = {
    domain: "project-setup-source-interface/v1", schemaVersion: 1, setupExecutionId, subjectId,
    transportCorrelationId, ownerKey: identity.ownerKey, projectName: project.definition.name, projectRevision: project.definition.revision,
    approvalRevision: 1, proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256,
    candidateDigest: setupApproval.candidateDigest, policyDigest: approval.policyDigest, policy: policy.data,
    sourceSnapshot: { ...snapshot, sources: snapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: source.kind, bytesBase64: Buffer.from(source.bytes).toString("base64") })) },
    // The worker reconstructs this exact selection against the retained snapshot bytes and then
    // recompiles. Snapshot bytes live once in the bounded content-addressed object above.
    selectionInput: Object.fromEntries(Object.entries(derived.selectionInput).filter(([key]) => key !== "sourceSnapshot")),
    setupRunContext, evidenceByteLimit,
    semanticApproval: derived.semanticApproval, planDigest: derived.planDigest, portableApprovalBinding: derived.portableApprovalBinding,
    scenarios: derived.scenarios, selectedTargetIds: derived.targetIds,
    unsupportedTargetIds: derived.unsupportedTargetIds,
    discoveredApplications: derived.discoveredApplications, discoveryMissingInputs: derived.discoveryMissingInputs,
    discoveredTargetIds: derived.discoveredTargetIds,
    notExecutedTargetIds: derived.unsupportedTargetIds,
    runtime: { runtimeCatalogId: runtime.runtimeCatalogId, catalogRevision: runtime.catalogRevision, bindingDigest: runtime.bindingDigest,
      manifestDigest: runtime.manifestDigest, runnerEnvironment: runtime.runnerEnvironment, generation: runtime.generation,
      transportCorrelationId, endpoint: runtime.endpoint, expiresAt: runtime.expiresAt },
    ...(retry ? { retryOfExecutionId: retry.retryOfExecutionId, retryActorKey: identity.ownerKey } : {}),
  };
  await assertNoRequalifyHold(dependencies, Date.now()); // AUTOREQUALIFY: no new setup run while the test machine is being switched
  const executionBytes = Buffer.from(canonicalJson(executionObject), "utf8");
  const executionDigest = createHash("sha256").update(executionBytes).digest("hex");
  const executionRef = { key: `project-setup-executions/sha256/${executionDigest}.json`, sha256: executionDigest, byteLength: executionBytes.byteLength };
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: executionRef.key, Body: executionBytes,
      ContentType: "application/json", Metadata: { sha256: executionDigest, owner: identity.ownerKey, candidate: setupApproval.candidateDigest }, IfNoneMatch: "*" }));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }).name : undefined;
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (code !== "PreconditionFailed" && status !== 412) throw error;
    if (await readStoredText(dependencies.s3, dependencies.artifactBucketName, executionRef.key, MAX_SETUP_PROPOSAL_BYTES) !== executionBytes.toString("utf8")) return undefined;
  }
  const execution = ProjectSetupExecutionSchema.parse({ schemaVersion: 1, setupExecutionId, subjectId, transportCorrelationId,
    projectName: project.definition.name, projectRevision: project.definition.revision, ownerKey: identity.ownerKey, approvalRevision: 1,
    proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256, candidateDigest: setupApproval.candidateDigest,
    policyDigest: approval.policyDigest, bindingDigest: runtime.bindingDigest, runtimeGeneration: runtime.generation,
    executionRef, runtimeCatalogId: runtime.runtimeCatalogId, runtimeCatalogRevision: runtime.catalogRevision,
    state: "ACCEPTED", operationId, outboxId, fence,
    deadlineAt: setupRunContext.deadlineAt, evidenceByteLimit, createdAt: now.toISOString(),
    ...(retry ? { retryOfExecutionId: retry.retryOfExecutionId, retryActorKey: identity.ownerKey } : {}) });
  const session = ProjectSetupSessionSchema.parse({ schemaVersion: 1, setupExecutionId, subjectId, transportCorrelationId,
    approvalRevision: 1, bindingDigest: runtime.bindingDigest, state: "READY", generation: runtime.generation, privateIp: endpoint.hostname });
  const operation = { ...projectSetupOperationKey(setupExecutionId, operationId), entityType: "PROJECT_SETUP_OPERATION",
    ...ProjectSetupOperationSchema.parse({ schemaVersion: 1, setupExecutionId, operationId, transportCorrelationId, fence,
      status: "ACCEPTED", createdAt: now.toISOString(), updatedAt: now.toISOString() }) };
  const callbackCapability = issueProjectSetupCapability(dependencies.callbackSigningKey, { domain: "PROJECT_SETUP", setupExecutionId, subjectId,
    transportCorrelationId, operationId, approvalRevision: 1, fence, expiresAt: Math.floor(now.getTime() / 1_000) + 32_400,
    actions: ["read-execution", "write-evidence", "result"] });
  const invocation = WorkerInvocationSchema.parse({ protocolVersion: AGENTX_PROTOCOL_VERSION, operationId, workspaceId: transportCorrelationId,
    fence, projectRevision: project.definition.revision, callbackCapability, kind: "project-setup-smoke",
    payload: { domain: "project-setup-source-interface/v1", setupExecutionId, subjectId, approvalRevision: 1, transportCorrelationId, executionRef } });
  const outbox = { pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "PENDING", operationId,
    workspaceId: transportCorrelationId, deploymentMode: "ec2-ebs", invocation, createdAt: now.toISOString() };
  const put = (item: Record<string, unknown>) => ({ Put: { TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  return { transactionItems: [put({ ...projectSetupExecutionKey(setupExecutionId), entityType: "PROJECT_SETUP_EXECUTION", ...execution }),
    put({ ...projectSetupSessionKey(setupExecutionId), entityType: "PROJECT_SETUP_SESSION", ...session }), put(operation), put(outbox),
    put(requalifySetupWorkRow(setupExecutionId, execution.deadlineAt)), requalifyHoldFence(dependencies.tableName, Date.now())] };
}

export async function retryProjectSetupAsAdministrator(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  setupExecutionId: string,
  value: unknown,
): Promise<{ setupExecutionId: string; operationId: string; status: "QUEUED"; duplicate: boolean }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required for an explicit setup retry");
  const input = z.object({ requestId: z.string().uuid() }).strict().parse(value);
  const idempotencyKey = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `RETRY#${identity.ownerKey}#${input.requestId}` };
  const executionKey = projectSetupExecutionKey(setupExecutionId);
  const raw = await getItem<Record<string, unknown>>(dependencies, executionKey);
  const parked = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(raw, executionKey, "PROJECT_SETUP_EXECUTION"));
  if (!parked.success) throw agentXError("STALE_FENCE", "only a current setup execution can be retried");
  const expiredDispatch = parked.data.state === "DISPATCHING" && parked.data.result === undefined && Date.parse(parked.data.deadlineAt) <= Date.now();
  const priorOperationKey = projectSetupOperationKey(setupExecutionId, parked.data.operationId);
  const priorOperationResponse = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: priorOperationKey, ConsistentRead: true }));
  const priorOperation = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(priorOperationResponse.Item, priorOperationKey, "PROJECT_SETUP_OPERATION"));
  const parkedRetry = parked.data.state === "PARKED" && parked.data.result !== undefined
    && priorOperation.success && priorOperation.data.status === "PARKED";
  const expiredDispatchRetry = expiredDispatch && priorOperation.success
    && (priorOperation.data.status === "DISPATCHING" || priorOperation.data.status === "DELIVERED")
    && priorOperation.data.setupExecutionId === setupExecutionId && priorOperation.data.operationId === parked.data.operationId
    && priorOperation.data.fence === parked.data.fence && priorOperation.data.transportCorrelationId === parked.data.transportCorrelationId;
  if (!parkedRetry && !expiredDispatchRetry) throw agentXError("STALE_FENCE", "only an owned parked setup execution or an expired matching dispatch can be retried");
  if (identity.ownerKey !== parked.data.ownerKey) throw agentXError("FORBIDDEN", "setup retry actor must be the original project creator");
  await requirePricedTaskStopAdmission(dependencies, { orgId: identity.orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, workKind: "admin-setup-retry" });
  const project = await requireRecordProject(dependencies, parked.data, parked.data.projectName, parked.data.projectRevision);
  await requireAdministrator(dependencies, identity, parked.data.projectName);
  if (project.runtimeBinding.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "the approved setup runtime profile is unavailable");
  if (project.registeredBy !== parked.data.ownerKey || project.setupApproval?.decision !== "approve"
    || project.setupApproval.proposalRef !== parked.data.proposalRef || project.setupApproval.proposalSha256 !== parked.data.proposalSha256
    || project.setupApproval.candidateDigest !== parked.data.candidateDigest || project.definition.e2e === undefined
    || !dependencies.projectSetupRuntimeCatalogId || dependencies.projectSetupRuntimeCatalogId !== parked.data.runtimeCatalogId
    || projectSetupBindingDigest(project.runtimeBinding) !== parked.data.bindingDigest) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "setup source, policy, binding, or catalog changed; complete normal approval before retry");
  }
  const approval = await getItem<Record<string, unknown>>(dependencies, projectSetupApprovalKey(await orgOfRecord(dependencies, parked.data), project.definition.name, parked.data.proposalSha256));
  if (!approval || approval.ownerKey !== parked.data.ownerKey || approval.decision !== "approve" || approval.proposalRef !== parked.data.proposalRef
    || approval.policyDigest !== parked.data.policyDigest || !sameJsonContent(approval.policy, project.definition.e2e)) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "current setup approval no longer matches the parked source and policy");
  }
  const runtimeKey = projectSetupRuntimeKey(parked.data.runtimeCatalogId, parked.data.bindingDigest);
  const runtimeItem = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: runtimeKey, ConsistentRead: true }));
  const runtime = ProjectSetupRuntimeRecordSchema.safeParse(projectSetupRuntimeRecord(runtimeItem.Item, runtimeKey));
  if (!runtime.success) throw agentXError("RUNTIME_UNAVAILABLE", "the exact approved setup runtime binding is unavailable");
  const admittedRuntime = admitProjectSetupRuntime(runtime.data, { runtimeCatalogId: parked.data.runtimeCatalogId, binding: project.runtimeBinding,
    scope: "source-interface", now: Date.now() });
  if (!admittedRuntime || admittedRuntime.catalogRevision !== parked.data.runtimeCatalogRevision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "the admitted setup catalog revision changed; complete normal approval before retry");
  }
  if (!(await setupAdmissionMatchesExecution(dependencies, parked.data))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the immutable setup admission does not match its stored execution identity");
  }
  const sessionKey = projectSetupSessionKey(setupExecutionId);
  const sessionResponse = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: sessionKey, ConsistentRead: true }));
  const session = ProjectSetupSessionSchema.safeParse(projectSetupDomainRecord(sessionResponse.Item, sessionKey, "PROJECT_SETUP_SESSION"));
  if (!session.success || session.data.setupExecutionId !== setupExecutionId || session.data.subjectId !== parked.data.subjectId
    || session.data.transportCorrelationId !== parked.data.transportCorrelationId || session.data.approvalRevision !== parked.data.approvalRevision
    || session.data.bindingDigest !== parked.data.bindingDigest || session.data.generation !== parked.data.runtimeGeneration || session.data.state !== "READY") {
    throw agentXError("RUNTIME_UNAVAILABLE", "the exact approved setup session is no longer ready");
  }
  const prior = await getItem<Record<string, unknown>>(dependencies, idempotencyKey);
  if (prior && prior.entityType === "PROJECT_SETUP_RETRY" && prior.previousExecutionId === setupExecutionId
    && prior.retryActorKey === identity.ownerKey && prior.originalCreatorKey === parked.data.ownerKey
    && typeof prior.setupExecutionId === "string" && typeof prior.operationId === "string") {
    return { setupExecutionId: prior.setupExecutionId, operationId: prior.operationId, status: "QUEUED", duplicate: true };
  }
  const setupApproval = project.setupApproval;
  const rows = await createProjectSetupAdmissionRows(dependencies, { ...identity, auditActor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) } }, project, setupApproval, admittedRuntime,
    { attemptId: input.requestId, retryOfExecutionId: setupExecutionId });
  if (!rows) throw agentXError("RUNTIME_UNAVAILABLE", "the approved source-interface setup run cannot be admitted");
  const executionPut = rows.transactionItems.find((item) => "Put" in item && (item as { Put: { Item?: { entityType?: unknown } } }).Put.Item?.entityType === "PROJECT_SETUP_EXECUTION") as { Put: { Item: Record<string, unknown> } } | undefined;
  const operationPut = rows.transactionItems.find((item) => "Put" in item && (item as { Put: { Item?: { entityType?: unknown } } }).Put.Item?.entityType === "PROJECT_SETUP_OPERATION") as { Put: { Item: Record<string, unknown> } } | undefined;
  if (!executionPut || !operationPut) throw agentXError("RUNTIME_UNAVAILABLE", "setup retry admission rows are incomplete");
  const nextExecution = executionPut.Put.Item;
  const nextOperation = operationPut.Put.Item;
  const marker = { ...idempotencyKey, entityType: "PROJECT_SETUP_RETRY", previousExecutionId: setupExecutionId,
    setupExecutionId: nextExecution.setupExecutionId, operationId: nextOperation.operationId, retryActorKey: identity.ownerKey,
    originalCreatorKey: parked.data.ownerKey, createdAt: new Date().toISOString() };
  const now = new Date().toISOString();
  const terminalAuthorityChecks = projectSetupTerminalAuthorityChecks(dependencies.tableName, await orgOfRecord(dependencies, parked.data), parked.data, runtime.data, session.data);
  const parkResult = { domain: "project-setup-source-interface/v1", candidateDigest: parked.data.candidateDigest,
    processStatus: "UNKNOWN", qualification: "UNKNOWN", cleanupConfirmed: false, parkReason: "setup-deadline-expired" };
  const priorExecutionMutation = expiredDispatchRetry
    ? { Update: { TableName: dependencies.tableName, Key: executionKey,
        UpdateExpression: "SET #state = :parked, updatedAt = :now, completedAt = :now, #result = :result",
        ConditionExpression: "#state = :dispatching AND operationId = :operationId AND subjectId = :subjectId AND fence = :fence AND approvalRevision = :approvalRevision AND transportCorrelationId = :correlation AND deadlineAt = :deadlineAt AND deadlineAt <= :now",
        ExpressionAttributeNames: { "#state": "state", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":now": now, ":result": parkResult,
          ":operationId": parked.data.operationId, ":subjectId": parked.data.subjectId, ":fence": parked.data.fence,
          ":approvalRevision": parked.data.approvalRevision, ":correlation": parked.data.transportCorrelationId,
          ":deadlineAt": parked.data.deadlineAt } } }
    : { ConditionCheck: { TableName: dependencies.tableName, Key: executionKey,
        ConditionExpression: "#state = :parked AND operationId = :operationId AND fence = :fence",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":operationId": parked.data.operationId, ":fence": parked.data.fence } } };
  const priorOperationMutation = expiredDispatchRetry
    ? { Update: { TableName: dependencies.tableName, Key: priorOperationKey,
        UpdateExpression: "SET #status = :parked, updatedAt = :now, #result = :result",
        ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":now": now,
          ":result": parkResult, ":setupExecutionId": setupExecutionId, ":operationId": parked.data.operationId,
          ":fence": parked.data.fence, ":correlation": parked.data.transportCorrelationId } } }
    : { ConditionCheck: { TableName: dependencies.tableName, Key: priorOperationKey,
        ConditionExpression: "#status = :parked AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":setupExecutionId": setupExecutionId,
          ":operationId": parked.data.operationId, ":fence": parked.data.fence, ":correlation": parked.data.transportCorrelationId } } };
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...terminalAuthorityChecks,
      priorExecutionMutation,
      priorOperationMutation,
      ...rows.transactionItems,
      { Put: { TableName: dependencies.tableName, Item: marker, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    ] }));
  } catch (error) {
    const duplicate = await getItem<Record<string, unknown>>(dependencies, idempotencyKey);
    if (duplicate?.entityType === "PROJECT_SETUP_RETRY" && duplicate.previousExecutionId === setupExecutionId
      && duplicate.retryActorKey === identity.ownerKey && duplicate.originalCreatorKey === parked.data.ownerKey
      && typeof duplicate.setupExecutionId === "string" && typeof duplicate.operationId === "string") {
      return { setupExecutionId: duplicate.setupExecutionId, operationId: duplicate.operationId, status: "QUEUED", duplicate: true };
    }
    await rethrowAsDeferredIfHeld(dependencies, error, Date.now()); // AUTOREQUALIFY: the start fence refused the retry
    throw error;
  }
  return { setupExecutionId: String(nextExecution.setupExecutionId), operationId: String(nextOperation.operationId), status: "QUEUED", duplicate: false };
}

export async function prepareWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<{ operationId: string; workspace: ReturnType<typeof publicWorkspace>; alreadyReady: boolean; duplicate?: boolean }> {
  const input = object(value, "workspace preparation");
  const requestId = uuid(input.requestId, "requestId");
  const projectName = name(input.projectName, "projectName");
  const projectRevision = positiveInteger(input.projectRevision, "projectRevision");
  if (typeof input.ownerSubject !== "string") throw agentXError("CONFIG_INVALID", "ownerSubject is required");
  await requireAdministrator(dependencies, identity, projectName);
  const targetOwnerKey = ownerKeyForSubject(dependencies.issuer, input.ownerSubject);
  const idempotency = await getItem<{ operationId: string; workspaceId: string }>(dependencies, {
    pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`,
    sk: `REQUEST#${requestId}`,
  });
  if (idempotency) {
    const workspace = await requireWorkspace(dependencies, idempotency.workspaceId);
    return { operationId: idempotency.operationId, workspace: publicWorkspace(workspace), alreadyReady: workspace.status === "READY", duplicate: true };
  }
  await requirePricedTaskStopAdmission(dependencies, { orgId: identity.orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, workKind: "admin-workspace-prepare" });
  const project = await requireProject(dependencies, requireOrgId(identity.orgId), projectName, projectRevision);
  const existing = await getDefaultWorkspace(dependencies, requireOrgId(identity.orgId), targetOwnerKey, projectName);
  if (existing) {
    if (existing.projectRevision !== projectRevision) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "existing workspace is pinned to another revision");
    }
    if (["READY", "STOPPED"].includes(existing.status)) {
      return { operationId: randomUUID(), workspace: publicWorkspace(existing), alreadyReady: true };
    }
    if (existing.status === "PREPARING" && existing.activeOperationId) {
      return {
        operationId: existing.activeOperationId,
        workspace: publicWorkspace(existing),
        alreadyReady: false,
        duplicate: true,
      };
    }
    if (existing.status === "PREPARATION_FAILED" && !existing.activeOperationId) {
      return retryWorkspacePreparation(
        dependencies,
        identity,
        requestId,
        targetOwnerKey,
        project,
        existing,
      );
    }
    throw agentXError("WORKSPACE_BUSY", `workspace cannot be prepared while ${existing.status}`);
  }

  // The target's membership is created here only when absent, recording who granted it. An existing row is checked, never rewritten: when it changed since
  // it was read, the transaction is refused and decided again from the row as it now is.
  for (let attempt = 0; attempt < MEMBERSHIP_PREPARATION_ATTEMPTS; attempt += 1) {
    const preparation = await newWorkspacePreparation(dependencies, identity, project, targetOwnerKey, requestId, { grantedBy: { issuer: identity.issuer, subject: identity.subject } });
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...preparation.items,
        { Put: { TableName: dependencies.tableName, Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: preparation.operationId, workspaceId: preparation.workspace.id }, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
    } catch (error) {
      if (!isConditional(error) || !await membershipMovedSince(dependencies, requireOrgId(identity.orgId), targetOwnerKey, project.definition.name, preparation.membership)) throw error;
      continue;
    }
    return { operationId: preparation.operationId, workspace: publicWorkspace(preparation.workspace), alreadyReady: false };
  }
  throw agentXError("WORKSPACE_BUSY", "the project membership kept changing while the workspace was prepared; try again with the same requestId");
}
