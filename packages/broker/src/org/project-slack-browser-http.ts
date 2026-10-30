import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { OrgIdSchema, ReviewedSlackUnbindBodySchema, ReviewedSlackProposeBodySchema, ReviewedSlackApproveBodySchema, ProjectSlackProposalViewSchema, agentXError, orgScoped, projectPk, type OrgId } from "@agentx/contracts";
import { takeRateAt } from "../developer/page-comments.js";
import type { AuditRuntime } from "../audit/outbox.js";
import type { SecondPersonEvidenceDependencies } from "./second-person-evidence.js";
import type { ProjectSlackChannelDependencies } from "./slack-binding.js";
import { readRequestRecord } from "./request-records.js";
import { commitProjectSlackUnbind, listProjectSlackBindings, readProjectSlackRequest, readProjectSlackTarget, requireProjectSlackAuthority } from "./project-slack-browser.js";
import { proposeProjectSlackBinding, approveProjectSlackBinding, readProjectSlackProposal, readLiveProjectSlackProposal } from "./project-slack-proposals.js";
interface Caller { developerId: string; orgId: OrgId; browserSession?: true }
type Dependencies = SecondPersonEvidenceDependencies & { audit?: AuditRuntime; orgs?: ProjectSlackChannelDependencies["orgs"] };
type Request = { operation: "list"; expectedOrgId: unknown; cursor?: string }
 | { operation: "target"; expectedOrgId: unknown; teamId: string; channelId: string }
 | { operation: "proposal"; expectedOrgId: unknown; proposalId?: string }
 | { operation: "propose"; body: unknown } | { operation: "approve"; proposalId: string; body: unknown }
 | { operation: "status"; expectedOrgId: unknown; requestId: string } | { operation: "unbind"; body: unknown };
async function budget(deps: Dependencies, caller: Caller, write: boolean) {
 const buckets = write ? [{ name: "SLACK_BINDING_WRITE_RATE", actor: caller.developerId, limit: 10 }, { name: "SLACK_BINDING_ORG_WRITE_RATE", actor: "ALL", limit: 60 }] : [{ name: "SLACK_BINDING_READ_RATE", actor: caller.developerId, limit: 30 }];
 for (const bucket of buckets) {
  let accepted: boolean;
  try { accepted = await takeRateAt(deps, { pk: orgScoped(caller.orgId, bucket.name), sk: bucket.actor }, bucket.limit, 60_000); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The Slack request budget could not be checked."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many Slack requests. Try again later.");
 }
}
/** Adapter only: browserSession is supplied exclusively by the existing live
 * cookie boundary. No bearer alias or token-driven Slack API call. */
export async function projectSlackBrowserHttp(deps: Dependencies, caller: Caller, project: string, request: Request) {
 if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session for Slack linking.");
 const company = z.object({ expectedOrgId: OrgIdSchema }).passthrough().safeParse(["unbind", "propose", "approve"].includes(request.operation) ? (request as { body: unknown }).body : request);
 if (!company.success || company.data.expectedOrgId !== caller.orgId) throw agentXError("CHANGE_STALE", "Refresh your company before checking Slack links.");
 const scope = { orgId: caller.orgId, project, by: caller.developerId };
 if (request.operation === "propose" || request.operation === "approve" || request.operation === "proposal") {
  await requireProjectSlackAuthority(deps, scope);
  if (deps.orgs === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Slack linking is unavailable.");
  const full = { ...deps, orgs: deps.orgs };
  const view = (proposal: Awaited<ReturnType<typeof readProjectSlackProposal>> | null) => ({ kind: "proposal" as const, orgId: caller.orgId, project,
   proposal: proposal === null ? null : ProjectSlackProposalViewSchema.parse({ proposalId: proposal.proposalId, by: proposal.by, teamId: proposal.teamId, channelId: proposal.channelId,
    state: proposal.state, createdAt: proposal.createdAt, expiresAt: proposal.expiresAt,
    ...(proposal.mode === undefined ? {} : { mode: proposal.mode, decidedBy: proposal.decidedBy, decidedAt: proposal.decidedAt }) }) });
  if (request.operation === "proposal") {
   await budget(deps, caller, false);
   return view(request.proposalId === undefined ? await readLiveProjectSlackProposal(full, scope) : await readProjectSlackProposal(full, { ...scope, proposalId: request.proposalId }));
  }
  if (request.operation === "propose") {
   const parsed = ReviewedSlackProposeBodySchema.safeParse(request.body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review valid Slack IDs and a fresh request id.");
   const prior = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: projectPk(caller.orgId, project), sk: `SLACK_BINDING_PROPOSAL#${parsed.data.requestId}` }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
   await budget(deps, caller, prior === undefined);
   const body = { requestId: parsed.data.requestId, teamId: parsed.data.teamId, channelId: parsed.data.channelId, expectedContextDigest: parsed.data.expectedContextDigest };return view(await proposeProjectSlackBinding(full, { ...scope, body }));
  }
  const parsed = ReviewedSlackApproveBodySchema.safeParse(request.body);if (!parsed.success || !z.string().uuid().safeParse(request.proposalId).success) throw agentXError("CONFIG_INVALID", "Review a valid Slack proposal before approval.");
  const prior = await readRequestRecord(deps.documentClient, deps.tableName, { pk: projectPk(caller.orgId, project), sk: `SLACK_BINDING_REQUEST#${parsed.data.requestId}` }, deps.now());
  await budget(deps, caller, prior === undefined);
  await approveProjectSlackBinding(full, { ...scope, proposalId: request.proposalId, requestId: parsed.data.requestId });
  return { kind: "receipt" as const, orgId: caller.orgId, project, receipt: await readProjectSlackRequest(deps, { ...scope, requestId: parsed.data.requestId }) };
 }
 if (request.operation === "unbind") {
  const parsed = ReviewedSlackUnbindBodySchema.safeParse(request.body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid Slack unlink before sending.");
  await requireProjectSlackAuthority(deps, scope);
  const prior = await readRequestRecord(deps.documentClient, deps.tableName, { pk: projectPk(caller.orgId, project), sk: `SLACK_BINDING_REQUEST#${parsed.data.requestId}` }, deps.now());
  await budget(deps, caller, prior === undefined);
  if (deps.orgs === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Slack linking is unavailable.");
  await commitProjectSlackUnbind({ ...deps, orgs: deps.orgs }, { ...scope, teamId: parsed.data.teamId, channelId: parsed.data.channelId, requestId: parsed.data.requestId, expectedContextDigest: parsed.data.expectedContextDigest });
  return { kind: "receipt" as const, orgId: caller.orgId, project, receipt: await readProjectSlackRequest(deps, { ...scope, requestId: parsed.data.requestId }) };
 }
 await requireProjectSlackAuthority(deps, scope);await budget(deps, caller, false);
 if (request.operation === "list") {
  if (request.cursor !== undefined && !z.string().min(1).max(1024).safeParse(request.cursor).success) throw agentXError("CONFIG_INVALID", "Refresh the Slack binding list before continuing.");
  return listProjectSlackBindings(deps, { ...scope, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) });
 }
 if (request.operation === "target") return readProjectSlackTarget(deps, { ...scope, teamId: request.teamId, channelId: request.channelId });
 return { kind: "receipt" as const, orgId: caller.orgId, project, receipt: await readProjectSlackRequest(deps, { ...scope, requestId: request.requestId }) };
}
