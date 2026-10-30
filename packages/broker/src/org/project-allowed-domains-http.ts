import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, OrgIdSchema, ProjectDefinitionSchema, agentXError, orgScoped, projectPk, projectRevisionKey, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { takeRateAt } from "../developer/page-comments.js";
import { commitDirectProjectAllowedDomains, proposeProjectAllowedDomains, readProjectAllowedDomainsReview, readProjectAllowedDomainProposal, decideProjectAllowedDomainProposal, type AppliedDomainProposalProof, type AllowedDomainProposal } from "./project-allowed-domains.js";
import { readAllowedDomainActorConditions } from "./second-person-evidence.js";
export interface AllowedDomainBrowserDependencies extends ParametersOfProposal {
 registerApproved?: (actor: { orgId: OrgId; ownerKey: string }, value: { definition: ProjectDefinition; runtimeBinding: unknown }, proof: AppliedDomainProposalProof) => Promise<unknown>;
}
type ParametersOfProposal = Parameters<typeof proposeProjectAllowedDomains>[0];
type Dependencies = AllowedDomainBrowserDependencies;
interface Caller { developerId: string; orgId: OrgId; browserSession?: true }
type Request = { operation: "propose"; body: unknown } | { operation: "save"; body: unknown } | { operation: "status"; expectedOrgId: unknown; proposalId: string }
 | { operation: "approve" | "cancel" | "reject"; proposalId: string; body: unknown } | { operation: "request-status"; expectedOrgId: unknown; requestId: string } | { operation: "review"; expectedOrgId: unknown };
const missing = () => agentXError("NOT_FOUND", "Website proposal not found.");
function projection(proposal: AllowedDomainProposal, status: AllowedDomainProposal["state"] | "expired" | "stale") {
 return { kind: "proposal" as const, proposalId: proposal.proposalId, proposedBy: proposal.by, status, baseRevision: proposal.baseRevision, beforeDomains: proposal.beforeDomains, afterDomains: proposal.afterDomains,
  createdAt: proposal.createdAt, expiresAt: proposal.expiresAt };
}
async function budget(deps: Dependencies, caller: Caller, status: boolean) {
 const buckets = status ? [{ key: "ALLOWED_WEBSITE_STATUS", actor: caller.developerId, limit: 30 }]
  : [{ key: "ALLOWED_WEBSITE_MUTATIONS", actor: caller.developerId, limit: 10 }, { key: "ALLOWED_WEBSITE_ORG_MUTATIONS", actor: "ALL", limit: 60 }];
 for (const bucket of buckets) {
  let accepted: boolean;try { accepted = await takeRateAt(deps, { pk: orgScoped(caller.orgId, bucket.key), sk: bucket.actor }, bucket.limit, 60000); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The website request budget could not be checked."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many website requests. Try again later.");
 }
}
/** Browser adapter, not an authentication mechanism. Only the existing opaque
 * cookie+Origin/CSRF boundary may set browserSession; bearer callers never do. */
export async function projectAllowedDomainsHttp(deps: Dependencies, caller: Caller, encodedName: string, request: Request) {
 if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session for allowed websites.");
 let project: string;try { project = decodeURIComponent(encodedName); } catch { throw missing(); }
 if (!AgentXNameSchema.safeParse(project).success) throw missing();
 const rawBody = "body" in request ? z.record(z.string(), z.unknown()).safeParse(request.body) : undefined;
 if (rawBody !== undefined && !rawBody.success) throw agentXError("CONFIG_INVALID", "Review a valid website request.");
 const expectedOrg = OrgIdSchema.safeParse("expectedOrgId" in request ? request.expectedOrgId : rawBody?.success ? rawBody.data.expectedOrgId : undefined);
 if (!expectedOrg.success) throw agentXError("CONFIG_INVALID", "Review a valid company for this website request.");
 if (expectedOrg.data !== caller.orgId) throw agentXError("CHANGE_STALE", "The active company changed. Review again.");
 // Live authority precedes budgets and proposal existence. No roster or provider
 // is consulted for this inexpensive admission check.
 await readAllowedDomainActorConditions(deps, { orgId: caller.orgId, project, actorId: caller.developerId });
 if (request.operation === "review") {
  await budget(deps, caller, true);
  const review = await readProjectAllowedDomainsReview(deps, { orgId: caller.orgId, project, by: caller.developerId });
  return { ...review, kind: "review" as const, status: "review" as const, liveProposal: review.liveProposal === null ? null : projection(review.liveProposal.proposal, review.liveProposal.status) };
 }
 if (request.operation === "request-status") {
  await budget(deps, caller, true);return ownedRequest(deps, caller, project, request.requestId);
 }
 if (request.operation === "status") {
  await budget(deps, caller, true);
  if (!z.string().uuid().safeParse(request.proposalId).success) throw missing();
  const result = await readProjectAllowedDomainProposal(deps, { orgId: caller.orgId, project, by: caller.developerId, proposalId: request.proposalId });return projection(result.proposal, result.status);
 }
 if (rawBody === undefined || !rawBody.success) throw agentXError("CONFIG_INVALID", "Review a valid website request.");
 const { expectedOrgId: _expectedOrgId, ...body } = rawBody.data;void _expectedOrgId;
 if ((request.operation === "propose" || request.operation === "save") && !z.string().regex(/^[a-f0-9]{64}$/).safeParse(body.expectedContextDigest).success) throw agentXError("CONFIG_INVALID", "Refresh and review this project's websites before proposing a change.");
 const decisionBody = request.operation === "propose" || request.operation === "save" ? undefined : (request.operation === "approve"
  ? z.object({ requestId: z.string().uuid(), soleOwnerAcknowledged: z.boolean().default(false) }).strict()
  : z.object({ requestId: z.string().uuid(), reason: z.string().trim().max(280).optional() }).strict()).safeParse(body);
 if (decisionBody !== undefined && !decisionBody.success) throw agentXError("CONFIG_INVALID", "Review a valid website decision.");
 if (request.operation !== "propose" && request.operation !== "save" && !z.string().uuid().safeParse(request.proposalId).success) throw missing();
 let ownedReplay = false;
 if (z.string().uuid().safeParse(body.requestId).success) {
  const row = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: projectPk(caller.orgId, project), sk: `EGRESS_PROPOSAL#${String(body.requestId)}` }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  ownedReplay = row?.orgId === caller.orgId && row.project === project && row.by === caller.developerId && row.entityType === "EGRESS_PROPOSAL" && (request.operation === "save" ? row.mode === "direct_narrowing" && (row.kind === undefined || row.kind === "direct_narrowing") : row.kind === (request.operation === "propose" ? "widening" : request.operation === "approve" ? "approval_receipt" : "decision_receipt"));
 }
 // Replays use the read budget. The core still checks exact body/digest before
 // returning a receipt; this shortcut grants no write or proposal authority.
 await budget(deps, caller, ownedReplay);
 if (request.operation === "save") {
  const result = await commitDirectProjectAllowedDomains(deps, { orgId: caller.orgId, project, by: caller.developerId, body });
  if (result.state === "unchanged") return { kind: "unchanged" as const, status: "unchanged" as const, resultRevision: result.resultRevision };
  return ownedRequest(deps, caller, project, result.requestId);
 }
 if (request.operation !== "propose") {
  if (decisionBody === undefined || !decisionBody.success) throw agentXError("CONFIG_INVALID", "Review a valid website decision.");
  if (request.operation === "cancel" || request.operation === "reject") {
   await decideProjectAllowedDomainProposal(deps, { orgId: caller.orgId, project, by: caller.developerId, body: { ...decisionBody.data, proposalId: request.proposalId, decision: request.operation } });
  } else {
   if (deps.registerApproved === undefined) throw agentXError("NOT_FOUND", "Website approval is unavailable in this deployment.");
   const result = await readProjectAllowedDomainProposal(deps, { orgId: caller.orgId, project, by: caller.developerId, proposalId: request.proposalId });
   if (!ownedReplay && result.status !== "pending") throw agentXError("CHANGE_STALE", "The website proposal changed. Review again.");
   const proposal = result.proposal;
   const base = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectRevisionKey(caller.orgId, project, proposal.baseRevision), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
   if (base === undefined) throw agentXError("CHANGE_STALE", "The website proposal changed. Review again.");
   const definition = ProjectDefinitionSchema.parse({ ...(base.definition as Record<string, unknown>), revision: proposal.baseRevision + 1, network: { allowedDomains: proposal.afterDomains } });
   await deps.registerApproved({ orgId: caller.orgId, ownerKey: caller.developerId }, { definition, runtimeBinding: base.runtimeBinding }, {
    requestId: String(decisionBody.data.requestId), proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, afterDigest: proposal.afterDigest,
    soleOwnerAcknowledged: "soleOwnerAcknowledged" in decisionBody.data && decisionBody.data.soleOwnerAcknowledged === true,
   });
  }
  return ownedRequest(deps, caller, project, String(decisionBody.data.requestId));
 }
 const proposal = await proposeProjectAllowedDomains(deps, { orgId: caller.orgId, project, by: caller.developerId, body });
 const result = await readProjectAllowedDomainProposal(deps, { orgId: caller.orgId, project, by: caller.developerId, proposalId: proposal.proposalId });return projection(result.proposal, result.status);
}

async function ownedRequest(deps: Dependencies, caller: Caller, project: string, requestId: string) {
 if (!z.string().uuid().safeParse(requestId).success) throw missing();
 const row = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: projectPk(caller.orgId, project), sk: `EGRESS_PROPOSAL#${requestId}` }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
 if (row === undefined || row.orgId !== caller.orgId || row.project !== project || row.by !== caller.developerId || row.entityType !== "EGRESS_PROPOSAL") throw missing();
 if (row.kind === "widening") { const result = await readProjectAllowedDomainProposal(deps, { orgId: caller.orgId, project, by: caller.developerId, proposalId: requestId });return projection(result.proposal, result.status); }
 if (row.mode === "direct_narrowing" && (row.kind === undefined || row.kind === "direct_narrowing")) {
  const direct = z.object({ requestId: z.literal(requestId), state: z.literal("applied"), mode: z.literal("direct_narrowing"), bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
   baseRevision: z.number().int().positive(), resultRevision: z.number().int().positive(), createdAt: z.string().datetime() }).passthrough().safeParse(row);
  if (!direct.success || direct.data.resultRevision !== direct.data.baseRevision + 1) throw agentXError("RUNTIME_UNAVAILABLE", "The website receipt could not be read.");
  await readAllowedDomainActorConditions(deps, { orgId: caller.orgId, project, actorId: caller.developerId });
  return { kind: "receipt" as const, status: "applied" as const, receipt: { requestId, state: "applied" as const, mode: "direct_narrowing" as const, createdAt: direct.data.createdAt, resultRevision: direct.data.resultRevision } };
 }
 const parsed = z.object({ requestId: z.literal(requestId), proposalId: z.string().uuid(), state: z.enum(["applied", "rejected", "cancelled"]), createdAt: z.string().datetime(),
  mode: z.enum(["second_person", "sole_owner_exception"]).optional(), resultRevision: z.number().int().positive().optional() }).passthrough().safeParse(row);
 if (!parsed.success || (row.kind !== "approval_receipt" && row.kind !== "decision_receipt") || (row.kind === "approval_receipt" ? parsed.data.state !== "applied" || parsed.data.mode === undefined || parsed.data.resultRevision === undefined : parsed.data.state === "applied")) throw agentXError("RUNTIME_UNAVAILABLE", "The website receipt could not be read.");
 await readAllowedDomainActorConditions(deps, { orgId: caller.orgId, project, actorId: caller.developerId });
 return { kind: "receipt" as const, proposalId: parsed.data.proposalId, status: parsed.data.state,
  receipt: { requestId, proposalId: parsed.data.proposalId, state: parsed.data.state, createdAt: parsed.data.createdAt,
   ...(parsed.data.mode === undefined ? {} : { mode: parsed.data.mode }), ...(parsed.data.resultRevision === undefined ? {} : { resultRevision: parsed.data.resultRevision }) } };
}
