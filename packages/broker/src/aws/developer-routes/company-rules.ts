// Company rules (G-04, owner decisions 57 and 85; switch `si`, StandingInstructionsEnabled): the admin's routes. With the switch off every path falls through as any unknown path. The API is described in `briefs/company-rules-api.md`.
//   GET   /v1/app/org/company-rules                 any live member: the version in force (a member sees rules, version and time only). An owner or admin also sees who made it, the waiting proposal with its diff, the file link.
//   GET   /v1/app/org/company-rules/history         owner or admin: approved versions (newest first) and the last proposals that did not become one.
//   GET   /v1/app/org/company-rules/versions/<n>    owner or admin: one version and its diff from the one before.
//   GET   /v1/app/org/company-rules/sync            owner or admin: the connected file's status, what it held at the last look, and its diff against the version in force.
//   POST  /v1/app/org/company-rules                 a live owner or admin, from a LIVE BROWSER SESSION (a token or the API is refused here and before this in the entry file); `service.ts` and `sync.ts` hold the rules:
//           { action: "propose", requestId, baseVersion, rules, note? }           the one waiting proposal (202 needs_approval);
//           { action: "approve", proposalId, expectedDigest, soleOwnerAcknowledged? }   a different admin, signed in within 10 minutes;
//           { action: "reject", proposalId, expectedDigest } / { action: "cancel", proposalId };
//           { action: "sync-connect", repository, path?, branch? } / { action: "sync-disconnect" } / { action: "sync-now" }.
// Answers are ids, counts, fixed words and the rules' own text; never an error text from a code host.
import { z } from "zod";
import {
  COMPANY_RULES_BROWSER_MESSAGE, COMPANY_RULES_PATH, CompanyRulesBodySchema, agentXError, type CompanyRulesAnswer, type CompanyRulesState,
} from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { requireLiveCompanyAdmin } from "../../org/company-authority.js";
import { approvalHint, approveProposal, cancelProposal, proposeRules, rejectProposal, type CompanyRulesDeps } from "../../company-rules/service.js";
import { dynamoCompanyRulesStore, type CompanyRulesStore } from "../../company-rules/store.js";
import { connectSync, disconnectSync, oweWriteBack, runSyncPass, type SyncDeps } from "../../company-rules/sync.js";
import { actorIds, historyView, limitsView, livePending, proposalView, syncSummaryView, syncView, versionView, type Names } from "../../company-rules/view.js";
import { diffRules } from "../../company-rules/rules.js";
import { standingInstructionsEnabled } from "../../instructions/switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { bodyError, signInStoreOf } from "./common.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export { COMPANY_RULES_BROWSER_MESSAGE, COMPANY_RULES_PATH };
/** Whether the path is this file's (the entry file refuses a token for a change before anything is read). */
export const isCompanyRulesPath = (pathname: string): boolean => pathname === COMPANY_RULES_PATH || pathname.startsWith(`${COMPANY_RULES_PATH}/`);
/** The switch: exactly "1" (the same reading as the standing block's). */
export const companyRulesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => standingInstructionsEnabled(env);

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";
const caller2 = (caller: DeveloperCaller) => ({ orgId: caller.orgId, developerId: caller.developerId });

/** The store over the State table, with the audit ledger (a write without one is refused by the store). */
export const companyRulesStoreOf = (deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "audit">): CompanyRulesStore =>
  dynamoCompanyRulesStore({ documentClient: deps.documentClient, tableName: deps.tableName, audit: deps.audit });

function serviceDepsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): CompanyRulesDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "Company rules are not available here.");
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName };
  return {
    store: companyRulesStoreOf(deps), now: deps.now,
    requireAdmin: (who) => requireLiveCompanyAdmin(table, who),
    requireFreshSignIn: async () => { await requireFreshSignIn(deps, caller); },
    evidence: { ...table, now: deps.now },
  };
}

function syncDepsOf(deps: DeveloperRouteDependencies, service: CompanyRulesDeps): SyncDeps | undefined {
  if (deps.companyRulesRepositories === undefined) return undefined;
  return { store: service.store, repos: deps.companyRulesRepositories, now: deps.now, requireAdmin: (who) => service.requireAdmin(who), requireFreshSignIn: (who) => service.requireFreshSignIn(who), log: (event, fields) => console.log(JSON.stringify({ component: "company_rules", event, ...fields })) };
}

/** Display names, best effort: a person whose name cannot be read is "Unknown", never an error. */
async function namesOf(deps: DeveloperRouteDependencies, ids: readonly string[]): Promise<Names> {
  const wanted = [...new Set(ids)].slice(0, 100);
  if (wanted.length === 0) return new Map();
  const found = await signInStoreOf(deps).getDevelopers(wanted).catch(() => new Map<string, unknown>());
  return new Map(wanted.map((id) => [id, (found.get(id) as { displayName?: string } | undefined)?.displayName ?? "Unknown"] as const));
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, service: CompanyRulesDeps): Promise<CompanyRulesState> {
  const admin = isAdmin(caller);
  const store = service.store;
  const head = await store.head(caller.orgId);
  const current = head.latestVersion === 0 ? undefined : await store.version(caller.orgId, head.latestVersion);
  // A head that names a version that cannot be read is never "no rules": the page says it could not read them.
  if (head.latestVersion > 0 && current === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read. Try again.");
  const viewer = { role: caller.orgRole === "owner" ? "owner" as const : admin ? "admin" as const : "member" as const, canPropose: admin, canDecide: admin };
  if (!admin) return { enabled: true, viewer, limits: limitsView(), current: current === undefined ? null : versionView(current, false, new Map()), pending: null, sync: null };
  const [waiting, sync] = await Promise.all([head.pendingProposalId === undefined ? undefined : store.proposal(caller.orgId, head.pendingProposalId), store.sync(caller.orgId)]);
  const pending = livePending(waiting, deps.now());
  const names = await namesOf(deps, [...actorIds(current?.approvedBy, current?.proposedBy, pending?.proposedBy), ...(sync === undefined ? [] : [sync.connectedBy])]);
  const hint = pending === undefined ? undefined : await approvalHint(service, caller2(caller), pending, head);
  return {
    enabled: true, viewer, limits: limitsView(),
    current: current === undefined ? null : versionView(current, true, names),
    pending: pending === undefined || hint === undefined ? null : proposalView(pending, { current: current?.rules ?? [], head, developerId: caller.developerId, names, hint: { ...hint, freshSignInNeeded: true } }),
    sync: syncSummaryView(sync),
  };
}

const VersionPath = /^\/v1\/app\/org\/company-rules\/versions\/([0-9]{1,9})$/u;
const HistoryLimit = z.coerce.number().int().min(1).max(50);
const Before = z.coerce.number().int().min(1).max(999_999_999);

async function readSub(deps: DeveloperRouteDependencies, caller: DeveloperCaller, service: CompanyRulesDeps, url: URL): Promise<StatusReply | undefined> {
  const path = url.pathname;
  const store = service.store;
  if (path === `${COMPANY_RULES_PATH}/history`) {
    await service.requireAdmin(caller2(caller));
    const limit = HistoryLimit.safeParse(url.searchParams.get("limit") ?? "20");
    const before = url.searchParams.get("before") === null ? undefined : Before.safeParse(url.searchParams.get("before"));
    if (!limit.success || (before !== undefined && !before.success)) throw agentXError("CONFIG_INVALID", "The history request is not valid.");
    const wanted = limit.data;
    // One more than asked for, so the page knows whether older versions exist.
    const versions = await store.versions(caller.orgId, { ...(before?.success ? { before: before.data } : {}), limit: wanted + 1 });
    const shown = versions.slice(0, wanted);
    const decided = await store.decided(caller.orgId, 20);
    const lowest = shown.length === 0 ? 0 : shown[shown.length - 1]!.version;
    const below = new Map(versions.map((version) => [version.version, version.rules] as const));
    const needed = lowest > 1 && !below.has(lowest - 1) ? await store.version(caller.orgId, lowest - 1) : undefined;
    const names = await namesOf(deps, [...shown.flatMap((version) => actorIds(version.approvedBy, version.proposedBy)), ...decided.flatMap((proposal) => actorIds(proposal.proposedBy, proposal.decidedBy))]);
    return new StatusReply(200, historyView({ versions: shown, before: (version) => below.get(version - 1) ?? (needed !== undefined && needed.version === version - 1 ? needed.rules : undefined), decided, names, limit: wanted, hasMoreBelow: versions.length > wanted }));
  }
  const one = VersionPath.exec(path);
  if (one !== null) {
    await service.requireAdmin(caller2(caller));
    const number = Number(one[1]);
    const version = await store.version(caller.orgId, number);
    if (version === undefined) throw agentXError("NOT_FOUND", "No such version.");
    const earlier = number > 1 ? await store.version(caller.orgId, number - 1) : undefined;
    const names = await namesOf(deps, actorIds(version.approvedBy, version.proposedBy));
    return new StatusReply(200, { version: versionView(version, true, names), diffFromPrevious: diffRules(earlier?.rules ?? [], version.rules) });
  }
  if (path === `${COMPANY_RULES_PATH}/sync`) {
    await service.requireAdmin(caller2(caller));
    const [head, sync] = await Promise.all([store.head(caller.orgId), store.sync(caller.orgId)]);
    const current = head.latestVersion === 0 ? undefined : await store.version(caller.orgId, head.latestVersion);
    if (head.latestVersion > 0 && current === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read. Try again.");
    const waiting = head.pendingProposalId === undefined ? undefined : livePending(await store.proposal(caller.orgId, head.pendingProposalId), deps.now());
    const names = await namesOf(deps, sync === undefined ? [] : [sync.connectedBy]);
    return new StatusReply(200, syncView(sync, { current, pendingFromRepo: waiting?.source === "repo", names }));
  }
  return undefined;
}

/** The reply, or undefined when the switch is off or the path is not this file's. */
export async function routeCompanyRules(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!companyRulesEnabled(env) || !isCompanyRulesPath(url.pathname)) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  if (request.method === "GET") {
    // The Auditor reads the audit log and nothing else; a role that is not on the positive list is refused.
    if (caller.orgRole !== "owner" && caller.orgRole !== "admin" && caller.orgRole !== "member") throw agentXError("FORBIDDEN", "Company rules are not available to your role.");
    const service = serviceDepsOf(deps, caller);
    if (url.pathname === COMPANY_RULES_PATH) return new StatusReply(200, await stateOf(deps, caller, service));
    if (!isAdmin(caller)) throw agentXError("FORBIDDEN", "Live company owner or admin access is required.");
    return readSub(deps, caller, service, url);
  }
  if (url.pathname !== COMPANY_RULES_PATH) return undefined;
  // Every change is a live browser session's. The entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", COMPANY_RULES_BROWSER_MESSAGE);
  const parsed = CompanyRulesBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw bodyError(parsed.error);
  const body = parsed.data;
  const service = serviceDepsOf(deps, caller);
  const who = caller2(caller);
  const sync = syncDepsOf(deps, service);
  const needSync = (): SyncDeps => { if (sync === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Connecting a repository is not set up here."); return sync; };
  let status: CompanyRulesAnswer["status"] = "done";
  switch (body.action) {
    case "propose": { await proposeRules(service, who, body); status = "needs_approval"; break; }
    case "approve": {
      await approveProposal(service, who, body); status = "approved";
      if (sync !== undefined) await oweWriteBack(sync, caller.orgId);
      break;
    }
    case "reject": {
      const rejected = await rejectProposal(service, who, body); status = "rejected";
      // Rovara is home: a rejected edit from the repository is answered by putting the version in force back in the file.
      if (sync !== undefined && rejected.proposal.source === "repo" && !rejected.replay) await oweWriteBack(sync, caller.orgId);
      break;
    }
    case "cancel": { await cancelProposal(service, who, body); status = "cancelled"; break; }
    // The person's authority is read before anything about this install is said.
    case "sync-connect": await service.requireAdmin(who); await connectSync(needSync(), who, body); break;
    case "sync-disconnect": await service.requireAdmin(who); await disconnectSync(needSync(), who); break;
    case "sync-now": await service.requireAdmin(who); await runSyncPass(needSync(), caller.orgId); break;
  }
  logDeveloperEvent({ event: "developer.company_rules_changed", orgId: caller.orgId, action: body.action });
  return new StatusReply(status === "needs_approval" ? 202 : 200, { status, state: await stateOf(deps, caller, service) } satisfies CompanyRulesAnswer);
}
