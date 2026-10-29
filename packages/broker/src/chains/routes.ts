// Plan 4 Task 4: the app's routes to design, publish, share and roll back chains (`/v1/app/chains*`). Every body is strict and carries a `requestId`
// (R18). Each route checks access first with `requireChainAccess`: a chain the caller can't see answers the same 404 as one that doesn't exist. A
// publish or rollback that makes anything less safe than what runs (less-safe.ts) answers `202 { status: "NEEDS_CONFIRMATION", confirmUrl, changes }`
// and changes nothing until a person confirms it on the page (R66), as Plan 3's agent changes do.
import { z } from "zod";
import {
  AGENTX_NAME_PATTERN,
  CHAIN_REVISION_CONFLICT_MESSAGE,
  CHAIN_START_INPUT_MAX,
  ChainIdSchema,
  ChainRunIdSchema,
  AgentOwnerSchema,
  MAX_SPEND_SETTING_USD,
  agentXError,
  atLeast,
  isBuiltinAgentId,
  projectAllows,
  type AgentAccessLevel,
  type ChainDefinitionInput,
  type ChainId,
  type OrgId,
  type OwnerCapChange,
} from "@agentx/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { checkShares, orgRoleOf, resolveSurvivor, whoNeeds, type AgentCaller } from "../agents/access.js";
import {
  confirmUrlFor, createPendingChange, registerApprovalSubjectHandler, registerApproverRule,
  type ApprovalDependencies, type ApprovalRecord, type ApproverSpec, type ChainChangeSubject,
} from "../agents/approvals.js";
import { orgAdmins } from "../agents/changes.js";
import { lessSafeChanges } from "../agents/less-safe.js";
import { holdingOwnerCap, jsonBody, markRequest, parseBody, waitingReplay, type AgentRouteDependencies } from "../agents/routes.js";
import { resolveAgent, type RecipeProblemsError } from "../agents/store.js";
import {
  chainAccess, listVisibleChains, requireChainAccess, requireChainAccountable, requireChainBudgetAllowed, requireChainOwnerAllowed, setChainShares,
  type ChainAccessDeps,
} from "./access.js";
import { withBudgetFields } from "../spend/owner-total.js";
import { chainLessSafeChanges, type ChainLessSafeLookups } from "./less-safe.js";
import { chainDigest, type ChainRecord, type ChainStore, type ChainVersion } from "./store.js";
import { cancelChainRun } from "./lifecycle.js";
import { chainRunEvents, chainRunView, chainStepTask, listChainRuns } from "./view.js";
import { startChainRun, type ChainRunRecord } from "./runner.js";
import { routeChainTriggers } from "../triggers/routes.js";
import { chainGraphProblems, formatChainProblem, validateChainForPublish, validatePinnedChainForOrg, type ChainProblem } from "./validate.js";

/** What the chain routes ask of the trigger code (Plan 4 Tasks 18 and 20), which builds it: until then there are no triggers and all three do nothing. */
export interface ChainTriggerHooks {
  /** Whether any trigger of the chain is enabled: while one is, only someone who manages the chain publishes or rolls it back. */
  hasEnabledTriggers(orgId: OrgId, chainId: string): Promise<boolean>;
  /** Re-checks every trigger of the chain against the version that now runs; the ones that no longer qualify are turned off, and answered here. */
  recheckTriggersForTarget(orgId: OrgId, target: { kind: "chain"; chainId: string }): Promise<Array<{ triggerId: string; problems: ChainProblem[] }>>;
  /** Turns the chain's triggers off (it was archived). */
  disableTriggersForTarget(orgId: OrgId, target: { kind: "chain"; chainId: string }): Promise<void>;
}

/**
 * What every chain route needs: Plan 3's route dependencies (access, the agent store, where the page lives, and what the owner total and spend requests read)
 * and the chain store.
 */
export interface ChainRouteDependencies extends AgentRouteDependencies {
  chains: ChainStore;
  chainTriggers?: ChainTriggerHooks;
}

/** The paths Plan 4 owns under `/v1/app/` for chains and their runs. */
export const isChainRoute = (pathname: string): boolean => /^\/v1\/app\/(chains|chain-runs)(\/|$)/.test(pathname);

/** A one-step design to start from when the person gives none: Root-cause analyst looks into whatever the run is asked about. */
export const STARTER_CHAIN_DEFINITION: ChainDefinitionInput = {
  start: "look_into_it",
  steps: [{ kind: "agent", id: "look_into_it", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }],
};

// ---- bodies

const RequestIdSchema = z.string().uuid();
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const DeveloperRefSchema = z.object({ developerId: Hex64 }).strict();
const NoteSchema = z.string().trim().min(1).max(200);
const CreateBodySchema = z.object({
  requestId: RequestIdSchema, name: z.string(), description: z.string().optional(), owner: AgentOwnerSchema.optional(), accountable: DeveloperRefSchema.optional(), definition: z.unknown().optional(),
}).strict();
const PutDraftBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(1), definition: z.unknown() }).strict();
const PublishBodySchema = z.object({ requestId: RequestIdSchema, expectedDraftRevision: z.number().int().min(1), note: NoteSchema.optional() }).strict();
const RollbackBodySchema = z.object({ requestId: RequestIdSchema, version: z.number().int().min(1) }).strict();
const RequestOnlySchema = z.object({ requestId: RequestIdSchema }).strict();
const SharesBodySchema = z.object({ requestId: RequestIdSchema, shares: z.array(z.unknown()) }).strict();
const OwnerBodySchema = z.object({ requestId: RequestIdSchema, owner: AgentOwnerSchema, accountable: DeveloperRefSchema.optional() }).strict();
const AccountableBodySchema = z.object({ requestId: RequestIdSchema, accountable: DeveloperRefSchema }).strict();
/** A chain's monthly budget in dollars, or `null` to clear it. */
const BudgetBodySchema = z.object({ requestId: RequestIdSchema, monthlyUsd: z.number().finite().min(0).max(MAX_SPEND_SETTING_USD).nullable() }).strict();

/** `POST /v1/app/chains/{id}/runs`: what the person says to start a run. The input is counted in characters, as Plan 3's context items are cut. */
const StartRunBodySchema = z.object({
  requestId: RequestIdSchema,
  project: z.string().regex(AGENTX_NAME_PATTERN),
  input: z.string().refine((text) => [...text].length <= CHAIN_START_INPUT_MAX, `must be at most ${String(CHAIN_START_INPUT_MAX)} characters`).optional(),
}).strict();

const SHARE_RANK = { view: 0, use: 1, edit: 2 } as const;

const notFound = () => agentXError("NOT_FOUND", "no chain has that ID");
const draftConflict = () => agentXError("CHAIN_REVISION_CONFLICT", CHAIN_REVISION_CONFLICT_MESSAGE);

/** The dependencies the access rules need, with the chain store in place of the agent store. */
const accessOf = (deps: ChainRouteDependencies): ChainAccessDeps => ({ ...deps, store: deps.chains });

// ---- how a chain is shown

type Shown = Record<string, unknown>;

function chainView(chain: ChainRecord, access: AgentAccessLevel): Shown {
  return {
    chainId: chain.chainId,
    name: chain.name,
    description: chain.description,
    owner: chain.owner,
    ...(chain.accountable === undefined ? {} : { accountable: chain.accountable }),
    ...(chain.currentVersion === undefined ? {} : { currentVersion: chain.currentVersion }),
    latestVersion: chain.latestVersion,
    draftRevision: chain.draftRevision,
    status: chain.status,
    ...(chain.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: chain.monthlyBudgetUsd }),
    openRuns: chain.openRuns,
    createdBy: chain.createdBy,
    createdAt: chain.createdAt,
    updatedAt: chain.updatedAt,
    access,
  };
}

function summaryView(chain: ChainRecord, access: AgentAccessLevel): Shown {
  return {
    chainId: chain.chainId,
    name: chain.name,
    description: chain.description,
    owner: chain.owner,
    ...(chain.currentVersion === undefined ? {} : { currentVersion: chain.currentVersion }),
    status: chain.status,
    access,
    ...(chain.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: chain.monthlyBudgetUsd }),
  };
}

const versionView = (version: ChainVersion, current: number | undefined): Shown => ({
  version: version.version, digest: version.digest, publishedBy: version.publishedBy, publishedAt: version.publishedAt,
  ...(version.note === undefined ? {} : { note: version.note }), current: version.version === current,
});

const waiting = (result: { confirmUrl: string; changes: string[] }): StatusReply =>
  new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: result.confirmUrl, changes: result.changes });

/** Re-reads a chain after a write, for the answer; the caller's access was checked before it. */
async function fresh(deps: ChainRouteDependencies, chain: ChainRecord): Promise<ChainRecord> {
  return await deps.chains.get(chain.orgId, chain.chainId) ?? chain;
}

// ---- who is asked, and what they are asked

/** The people shown a chain's change for confirmation: the owner (a member, or a project's accountable maintainer and `manage_agents` holders) and the org's owners and admins. The rule decides who may decide. */
async function chainApprovers(deps: ChainRouteDependencies, chain: ChainRecord): Promise<ApproverSpec> {
  const candidates = new Set(await orgAdmins(deps, chain.orgId));
  if (chain.owner.kind === "member") candidates.add(await resolveSurvivor(deps, chain.orgId, chain.owner.developerId));
  else {
    for (const member of await deps.projectMembers.list(chain.orgId, chain.owner.project)) if (projectAllows(member.role, "manage_agents")) candidates.add(member.developerId);
    if (chain.accountable !== undefined) candidates.add(await resolveSurvivor(deps, chain.orgId, chain.accountable.developerId));
  }
  return { kind: "rule", rule: "chain_publish", candidates: [...candidates] };
}

async function waitForPerson(
  deps: ChainRouteDependencies, caller: AgentCaller, chain: ChainRecord, requestId: string, subject: ChainChangeSubject, changes: string[],
): Promise<StatusReply> {
  // A change that needs a person can't be confirmed on an archived chain, so it is not asked for.
  if (chain.status === "archived") throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} is archived, so a change that needs confirmation can't be made. Unarchive it first, then ask again.`);
  const record = await createPendingChange(deps, { orgId: caller.orgId, requestId, requestedBy: caller.developerId, subject, changes, approvers: await chainApprovers(deps, chain) });
  // A replay of a request that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return waiting({ confirmUrl: confirmUrlFor(deps, record), changes: record.changes });
}

/** The two questions the less-safe comparison asks of the org: an agent's name, and what moving to a newer version of it adds. */
function lookupsOf(deps: ChainRouteDependencies, orgId: OrgId): ChainLessSafeLookups {
  const recipeOf = (agentId: string, version: number) => resolveAgent(deps.store, orgId, agentId, version, deps.resolveSkill === undefined ? {} : { resolveSkill: deps.resolveSkill });
  return {
    agentName: async (agentId) => (isBuiltinAgentId(agentId) ? deps.store.builtinName(agentId) : (await deps.store.get(orgId, agentId))?.name ?? agentId),
    repinFindings: async (agentId, from, to) => {
      try {
        return lessSafeChanges(await recipeOf(agentId, from), await recipeOf(agentId, to));
      } catch (error) {
        // A version that can't be resolved can't be shown to be no wider: it waits for a person.
        const first = (error as Partial<RecipeProblemsError>).problems?.[0];
        return [first === undefined ? "its recipe can't be compared with the one before" : `${first.path}: ${first.message}`];
      }
    },
  };
}

// ---- reads

async function listChains(deps: ChainRouteDependencies, caller: AgentCaller, url: URL): Promise<Shown> {
  const project = url.searchParams.get("project");
  let scope: Parameters<typeof listVisibleChains>[2];
  if (project !== null) {
    if (project.length === 0 || project.length > 200) throw agentXError("CONFIG_INVALID", "project: not a project name");
    scope = { project };
  } else {
    const named = url.searchParams.get("scope") ?? "all";
    if (named !== "all" && named !== "mine" && named !== "shared") throw agentXError("CONFIG_INVALID", "scope: must be one of all, mine, shared");
    scope = named;
  }
  return { chains: (await listVisibleChains(accessOf(deps), caller, scope)).map((visible) => summaryView(visible.record, visible.access)) };
}

async function getChain(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string): Promise<Shown> {
  const { chain, access } = await requireChainAccess(accessOf(deps), caller, chainId, "view");
  const current = chain.currentVersion === undefined ? undefined : await deps.chains.getVersion(chain.orgId, chain.chainId, chain.currentVersion);
  return { chain: chainView(chain, access), ...(current === undefined ? {} : { current: { version: current.version, definition: current.definition } }) };
}

async function listVersions(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string): Promise<Shown> {
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "view");
  return { versions: (await deps.chains.listVersions(chain.orgId, chain.chainId)).map((version) => versionView(version, chain.currentVersion)) };
}

async function getVersion(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, number: number): Promise<Shown> {
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "view");
  const version = await deps.chains.getVersion(chain.orgId, chain.chainId, number);
  if (version === undefined) throw agentXError("NOT_FOUND", `${chain.name} has no version ${String(number)}`);
  return { version: versionView(version, chain.currentVersion), definition: version.definition };
}

async function getDraft(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string): Promise<Shown> {
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "edit");
  const draft = await deps.chains.getDraft(chain.orgId, chain.chainId);
  if (draft === undefined) throw notFound();
  return { draft, problems: chainGraphProblems(draft.definition) };
}

async function getShares(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string): Promise<Shown> {
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "manage");
  return { shares: (await deps.chains.listShares(chain.orgId, chain.chainId)).map(({ principal, level, grantedBy, grantedAt }) => ({ principal, level, grantedBy, grantedAt })) };
}

// ---- writes

async function createChain(deps: ChainRouteDependencies, caller: AgentCaller, body: unknown): Promise<StatusReply> {
  const input = parseBody(CreateBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "chain-create", "", input);
  if (replay !== undefined) {
    // The chain as it is now, if the caller can still see it: a repeat is not a way to read what they no longer have.
    const { chain, access } = await requireChainAccess(accessOf(deps), caller, (replay.result as ChainRecord).chainId, "view");
    return new StatusReply(201, { chain: chainView(chain, access) });
  }
  const owner = await requireChainOwnerAllowed(deps, caller, input.owner ?? { kind: "member", developerId: caller.developerId });
  // A project's accountable maintainer must be able to manage its chains; a member's chain has none (the store refuses one).
  const accountable = input.accountable === undefined ? undefined : owner.kind === "project" ? await requireChainAccountable(deps, caller.orgId, owner.project, input.accountable.developerId) : input.accountable;
  const chain = await deps.chains.create({
    orgId: caller.orgId, name: input.name, owner, createdBy: caller.developerId,
    definition: input.definition ?? STARTER_CHAIN_DEFINITION,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(accountable === undefined ? {} : { accountable }),
    request: mark,
  });
  return new StatusReply(201, { chain: chainView(chain, await chainAccess(accessOf(deps), caller, chain)) });
}

async function putDraft(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<Shown> {
  const input = parseBody(PutDraftBodySchema, body);
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "edit");
  const { mark, replay } = await markRequest(deps, caller, "chain-draft", chainId, input);
  if (replay !== undefined) return { draft: replay.result };
  const draft = await deps.chains.saveDraft({ orgId: chain.orgId, chainId: chain.chainId, definition: input.definition, expectedRevision: input.expectedRevision, by: caller.developerId, request: mark });
  return { draft };
}

/** The version that runs, which a change is compared with: a chain that has one whose record can't be read is not compared with nothing. */
async function runningVersion(deps: ChainRouteDependencies, chain: ChainRecord): Promise<ChainVersion | undefined> {
  if (chain.currentVersion === undefined) return undefined;
  const running = await deps.chains.getVersion(chain.orgId, chain.chainId, chain.currentVersion);
  if (running === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `${chain.name} can't be changed right now: the version it runs could not be read. Try again in a moment.`);
  return running;
}

/** While a chain has an enabled trigger, changing the version it runs is for someone who manages it. */
async function requireManagerWhileTriggered(deps: ChainRouteDependencies, chain: ChainRecord, access: AgentAccessLevel): Promise<void> {
  if (atLeast(access, "manage")) return;
  if (await deps.chainTriggers?.hasEnabledTriggers(chain.orgId, chain.chainId) === true) {
    throw agentXError("FORBIDDEN", `${chain.name} has triggers turned on, so changing the version it runs needs ${whoNeeds(chain, "manage")}.`);
  }
}

/** The triggers the check turned off after a version change, for the answer. */
async function recheck(deps: ChainRouteDependencies, chain: ChainRecord): Promise<Array<{ triggerId: string; problems: ChainProblem[] }>> {
  return await deps.chainTriggers?.recheckTriggersForTarget(chain.orgId, { kind: "chain", chainId: chain.chainId }) ?? [];
}

/**
 * Publishes the draft at `expectedDraftRevision`. A design with problems is refused with the first of them; a design that makes nothing less safe
 * than what runs (or is the first publish) is published at once; any other waits for the owner or an org admin on the page, bound to this draft
 * revision and its digest.
 */
async function publishChain(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<unknown> {
  const input = parseBody(PublishBodySchema, body);
  const { chain, access } = await requireChainAccess(accessOf(deps), caller, chainId, "edit");
  await requireManagerWhileTriggered(deps, chain, access);
  const { mark, replay } = await markRequest(deps, caller, "chain-publish", chainId, input);
  if (replay !== undefined) return { version: replay.result as ChainVersion, chain: chainView(await fresh(deps, chain), access), disabledTriggers: [] };
  const draft = await deps.chains.getDraft(chain.orgId, chain.chainId);
  if (draft === undefined || draft.revision !== input.expectedDraftRevision || chain.draftRevision !== input.expectedDraftRevision) throw draftConflict();
  const checked = await validateChainForPublish(deps, caller, chain.orgId, draft.definition);
  const [problem] = checked.problems;
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", formatChainProblem(problem));
  const digest = chainDigest(checked.pinned);
  const running = await runningVersion(deps, chain);
  // A draft that is what already runs publishes nothing: a retry after the page confirmed this very draft is answered with that version.
  if (running !== undefined && running.digest === digest) return { version: running, chain: chainView(chain, access), disabledTriggers: [] };
  const changes = await chainLessSafeChanges(running?.definition, checked.pinned, lookupsOf(deps, chain.orgId));
  if (changes.length > 0) {
    const subject: ChainChangeSubject = {
      kind: "chain_publish", chainId: chain.chainId, draftRevision: input.expectedDraftRevision, digest,
      ...(chain.currentVersion === undefined ? {} : { expectedCurrentVersion: chain.currentVersion }),
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    return waitForPerson(deps, caller, chain, input.requestId, subject, changes);
  }
  // Only while what was compared against is still what runs: a rollback that lands in between changes the baseline.
  const version = await deps.chains.publish({
    orgId: chain.orgId, chainId: chain.chainId, expectedDraftRevision: input.expectedDraftRevision, pinned: checked.pinned, digest,
    guardrailsRevision: checked.guardrailsRevision, by: caller.developerId, expectedCurrentVersion: chain.currentVersion ?? null,
    ...(input.note === undefined ? {} : { note: input.note }), request: mark,
  });
  const disabledTriggers = await recheck(deps, chain);
  return { version, chain: chainView(await fresh(deps, chain), access), disabledTriggers };
}

/** Makes an earlier version current. A rollback is compared like a publish: one that makes anything less safe waits for the page. */
async function rollbackChain(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<unknown> {
  const input = parseBody(RollbackBodySchema, body);
  const { chain, access } = await requireChainAccess(accessOf(deps), caller, chainId, "edit");
  await requireManagerWhileTriggered(deps, chain, access);
  const { mark, replay } = await markRequest(deps, caller, "chain-rollback", chainId, input);
  if (replay !== undefined) return { chain: chainView(replay.result as ChainRecord, access), disabledTriggers: [] };
  if (chain.currentVersion === undefined) throw agentXError("CONFIG_INVALID", `${chain.name} has no published version to roll back from`);
  if (input.version === chain.currentVersion) throw agentXError("CONFIG_INVALID", `version: ${String(input.version)} is already the current version`);
  const target = await deps.chains.getVersion(chain.orgId, chain.chainId, input.version);
  if (target === undefined) throw agentXError("NOT_FOUND", `${chain.name} has no version ${String(input.version)}`);
  const running = await runningVersion(deps, chain);
  // The version was valid when it was published; it is made current only if it still is, for this person, under the guardrails of today.
  const checked = await validatePinnedChainForOrg(deps, caller, chain.orgId, target.definition);
  const [problem] = checked.problems;
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", formatChainProblem(problem));
  const changes = await chainLessSafeChanges(running?.definition, target.definition, lookupsOf(deps, chain.orgId));
  if (changes.length > 0) {
    const subject: ChainChangeSubject = { kind: "chain_rollback", chainId: chain.chainId, version: input.version, digest: target.digest, expectedCurrentVersion: chain.currentVersion };
    return waitForPerson(deps, caller, chain, input.requestId, subject, changes);
  }
  const rolled = await deps.chains.rollback({
    orgId: chain.orgId, chainId: chain.chainId, version: input.version, expectedCurrentVersion: chain.currentVersion, guardrailsRevision: checked.guardrailsRevision, by: caller.developerId, request: mark,
  });
  return { chain: chainView(rolled, access), disabledTriggers: await recheck(deps, chain) };
}

async function setArchived(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown, archive: boolean): Promise<Shown | StatusReply> {
  const input = parseBody(RequestOnlySchema, body);
  const { chain, access } = await requireChainAccess(accessOf(deps), caller, chainId, "manage");
  const { mark, replay } = await markRequest(deps, caller, archive ? "chain-archive" : "chain-unarchive", chainId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? { chain: chainView(replay.result as ChainRecord, access) };
  // An archived chain starts nothing, so its triggers go off with it. Unarchiving turns none back on: a person does that.
  if (archive) {
    const archived = await deps.chains.archive(chain.orgId, chain.chainId, caller.developerId, mark);
    await deps.chainTriggers?.disableTriggersForTarget(chain.orgId, { kind: "chain", chainId: chain.chainId });
    return { chain: chainView(archived, access) };
  }
  // Unarchiving puts the chain's budget back in its owner's one monthly total, held to the cap like any other raise of it.
  const unarchived = chain.status !== "archived"
    ? await deps.chains.unarchive(chain.orgId, chain.chainId, caller.developerId, mark)
    : await holdingOwnerCap(deps, caller, { kind: "chain", chainId: chain.chainId }, chain, withBudgetFields(chain, { status: "active" }), { op: "unarchive" }, mark,
      (options) => deps.chains.unarchive(chain.orgId, chain.chainId, caller.developerId, mark, options));
  if (unarchived instanceof StatusReply) return unarchived;
  return { chain: chainView(unarchived, access) };
}

async function putShares(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<unknown> {
  const input = parseBody(SharesBodySchema, body);
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "chain-shares", chainId, input);
  if (replay !== undefined) return { shares: replay.result };
  // Refused now, not when it is confirmed: a change nobody could apply is not worth asking a person about.
  const shares = await checkShares(accessOf(deps), chain.orgId, caller.developerId, input.shares, "chain");
  const wanted = shares.find((share) => share.principal.kind === "org");
  const stored = (await deps.chains.listShares(chain.orgId, chain.chainId)).find((share) => (share.principal as { kind?: unknown } | undefined)?.kind === "org");
  const widens = wanted !== undefined && (stored === undefined || SHARE_RANK[wanted.level] > (SHARE_RANK[stored.level] ?? -1));
  if (widens) {
    // Sharing with everyone, or letting everyone do more, waits for a person on the page, as an agent's does.
    const can = { view: "see", use: "run", edit: "change" }[wanted.level];
    const subject: ChainChangeSubject = { kind: "chain_share", chainId: chain.chainId, shares, expectedSharesRevision: chain.sharesRevision ?? 0 };
    return waitForPerson(deps, caller, chain, input.requestId, subject, [`Shares ${chain.name} with everyone in your company, who can then ${can} it`]);
  }
  return { shares: await setChainShares(accessOf(deps), { orgId: chain.orgId, chainId: chain.chainId, shares, by: caller.developerId, request: mark }) };
}

async function putOwner(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<Shown | StatusReply> {
  const input = parseBody(OwnerBodySchema, body);
  const { chain, access } = await requireChainAccess(accessOf(deps), caller, chainId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "chain-owner", chainId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? { chain: chainView(replay.result as ChainRecord, access) };
  // Store the owner this returns, not the one asked for: a member who was merged into another is named by the survivor.
  const owner = await requireChainOwnerAllowed(deps, caller, input.owner, chain.owner);
  const accountable = input.accountable === undefined ? undefined : owner.kind === "project" ? await requireChainAccountable(deps, caller.orgId, owner.project, input.accountable.developerId) : input.accountable;
  // The chain's budget leaves its owner's total and joins the new owner's (the maintainer accountable for a project's chain), which the cap holds.
  const { accountable: _before, ...kept } = chain; // eslint-disable-line @typescript-eslint/no-unused-vars -- the new owner decides it
  const change: OwnerCapChange = { op: "set_owner", owner, ...(accountable === undefined ? {} : { accountable }) };
  const moved = await holdingOwnerCap(deps, caller, { kind: "chain", chainId: chain.chainId }, chain, { ...kept, owner, ...(accountable === undefined ? {} : { accountable }) }, change, mark,
    (options) => deps.chains.setOwner(chain.orgId, chain.chainId, owner, caller.developerId, accountable, mark, { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, manageSnapshot: chain }));
  if (moved instanceof StatusReply) return moved;
  return { chain: chainView(moved, access) };
}

/** `PUT /v1/app/chains/{id}/accountable` [manage]: another maintainer answers for a project's chain; its budget moves to their total, which the cap holds. */
async function putAccountable(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<Shown | StatusReply> {
  const input = parseBody(AccountableBodySchema, body);
  const { chain } = await requireChainAccess(accessOf(deps), caller, chainId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "chain-accountable", chainId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? replay.result as Shown;
  if (chain.owner.kind !== "project") throw agentXError("CONFIG_INVALID", "accountable: only a project's chain has an accountable maintainer");
  const accountable = await requireChainAccountable(deps, caller.orgId, chain.owner.project, input.accountable.developerId);
  const done = await holdingOwnerCap(deps, caller, { kind: "chain", chainId: chain.chainId }, chain, withBudgetFields(chain, { accountable }), { op: "set_accountable", accountable }, mark,
    (options) => deps.chains.setAccountable(chain.orgId, chain.chainId, accountable, caller.developerId, mark, { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, manageSnapshot: chain }));
  if (done instanceof StatusReply) return done;
  return { accountable };
}

/**
 * `PUT /v1/app/chains/{id}/budget` [manage]: `{ requestId, monthlyUsd: number | null }`. The budget is refused above the company's guardrail for one agent or
 * chain, and counted in its owner's one monthly total with their agents' budgets: a change that would take that total's effective sum (with this month's
 * top-ups) past `ownerAgentBudgetCapUsd` is not made; an org admin is asked (`202 NEEDS_ADMIN_APPROVAL`), and the budget stays as it was until they approve it.
 */
async function putBudget(deps: ChainRouteDependencies, caller: AgentCaller, chainId: string, body: unknown): Promise<Shown | StatusReply> {
  const input = parseBody(BudgetBodySchema, body);
  const { chain, access } = await requireChainAccess(accessOf(deps), caller, chainId, "manage");
  const { mark, replay } = await markRequest(deps, caller, "chain-budget", chainId, input);
  if (replay !== undefined) return waitingReplay(replay.result) ?? { chain: chainView(replay.result as ChainRecord, access) };
  // Checked now, and again when an admin approves it over the owner cap: either may have changed meanwhile.
  await requireChainBudgetAllowed(deps, caller.orgId, input.monthlyUsd);
  const monthlyUsd = input.monthlyUsd === null ? undefined : input.monthlyUsd;
  const written = await holdingOwnerCap(deps, caller, { kind: "chain", chainId: chain.chainId }, chain, withBudgetFields(chain, { monthlyBudgetUsd: monthlyUsd }), { op: "set_budget", budget: { monthlyUsd: input.monthlyUsd } }, mark,
    (options) => deps.chains.setBudget(chain.orgId, chain.chainId, monthlyUsd, caller.developerId, mark, { ...options, manageSnapshot: chain, actor: { developerId: caller.developerId, role: caller.orgRole } }));
  if (written instanceof StatusReply) return written;
  // A chain whose budget is gone can't be started by an event or a schedule: the triggers that no longer qualify are turned off, and the answer says which.
  return { chain: chainView(written, access), disabledTriggers: await recheck(deps, chain) };
}

// ---- starting a run

/** A run as the person who started it is shown it: where it stands, what it has cost and why it ended. The full view of a run is Task 10's. */
function runStartView(run: ChainRunRecord): Shown {
  return {
    runId: run.runId, chainId: run.chainId, chainName: run.chainName, chainVersion: run.chainVersion, project: run.project, status: run.status, owner: run.owner, startedBy: run.startedBy,
    origin: run.origin, ...(run.input === undefined ? {} : { input: run.input }), runLimitUsd: run.runLimitUsd, spentUsd: run.spentUsd, currentSeq: run.currentSeq,
    createdAt: run.createdAt, updatedAt: run.updatedAt, ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }), ...(run.failure === undefined ? {} : { failure: run.failure }),
  };
}

async function startRun(deps: ChainRouteDependencies, caller: AgentCaller, chainId: ChainId, body: unknown): Promise<StatusReply> {
  if (deps.chainRuns === undefined) throw agentXError("NOT_FOUND", "chain runs are not set up in this deployment");
  const input = parseBody(StartRunBodySchema, body);
  const run = await startChainRun({ ...deps, chainRuns: deps.chainRuns }, caller, {
    orgId: caller.orgId, chainId, project: input.project, origin: "app", startedBy: { kind: "member", developerId: caller.developerId }, requestId: input.requestId,
    ...(input.input === undefined ? {} : { input: input.input }),
  });
  return new StatusReply(202, { run: runStartView(run) });
}

/** `POST /v1/app/chain-runs/{id}/cancel`: stops a run (Task 9). The body is the request id alone; who may is `cancelChainRun`'s to say. */
async function cancelRun(deps: ChainRouteDependencies, caller: AgentCaller, rawId: string, body: unknown): Promise<Shown> {
  if (deps.chainRuns === undefined) throw agentXError("NOT_FOUND", "chain runs are not set up in this deployment");
  if (!ChainRunIdSchema.safeParse(rawId).success) throw agentXError("NOT_FOUND", "no chain run has that ID");
  const input = parseBody(RequestOnlySchema, body);
  const run = await cancelChainRun({ ...deps, chainRuns: deps.chainRuns }, caller, rawId, { requestId: input.requestId });
  return { run: runStartView(run) };
}

// ---- reading a run (Task 10)

const CHAIN_RUN_READ_PATH = /^\/v1\/app\/chain-runs(?:\/([^/]+)(?:\/(events)|\/sections\/([^/]+)\/task)?)?$/;

/** One query value that may appear once at most; a repeat is refused rather than read as the first. */
function oneParam(url: URL, name: string): string | undefined {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) throw agentXError("CONFIG_INVALID", `${name}: give it once`);
  return all[0];
}

/**
 * `GET /v1/app/chain-runs*` (Task 10): the list, a run's view, its events and a step's task. Nothing a query parameter, a header or a body holds changes who the caller is or
 * what they may read: the functions read the caller's own org and rules, and the session actor Plan 5 uses is an argument they take, never a field of a request.
 */
async function readRuns(deps: ChainRouteDependencies, caller: AgentCaller, matched: RegExpExecArray, url: URL): Promise<Shown> {
  const [, rawId, events, rawSeq] = matched;
  if (rawId === undefined) {
    return listChainRuns(deps, caller, { chain: oneParam(url, "chain"), project: oneParam(url, "project"), status: oneParam(url, "status"), cursor: oneParam(url, "cursor") });
  }
  if (events !== undefined) {
    const after = oneParam(url, "after");
    if (after !== undefined && !/^\d{1,7}$/.test(after)) throw agentXError("CONFIG_INVALID", "after: must be a whole number from 0 to 999999");
    return chainRunEvents(deps, caller, rawId, after === undefined ? 0 : Number(after));
  }
  if (rawSeq !== undefined) {
    if (!/^\d{1,4}$/.test(rawSeq)) throw agentXError("NOT_FOUND", "no chain run has that ID");
    return chainStepTask(deps, caller, rawId, Number(rawSeq));
  }
  return chainRunView(deps, caller, rawId);
}

// ---- routing

const CHAIN_RUN_CANCEL_PATH = /^\/v1\/app\/chain-runs\/([^/]+)\/cancel$/;
const CHAIN_PATH = /^\/v1\/app\/chains(?:\/([^/]+)(?:\/([a-z-]+)(?:\/([0-9]{1,6}))?)?)?$/;

/**
 * `routeChainRequest(deps, caller, request, url)`: the chain routes. A path under Plan 4's prefixes that no task has built yet answers 404 `"that isn't available yet"`.
 */
export async function routeChainRequest(deps: ChainRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const cancelling = CHAIN_RUN_CANCEL_PATH.exec(url.pathname);
  if (cancelling !== null) {
    if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    return cancelRun(deps, caller, cancelling[1]!, jsonBody(request));
  }
  const reading = CHAIN_RUN_READ_PATH.exec(url.pathname);
  if (reading !== null) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    return readRuns(deps, caller, reading, url);
  }
  // Plan 4 Task 18: a chain's triggers (`/v1/app/chains/{id}/triggers*`).
  const triggers = await routeChainTriggers(deps, caller, request, url);
  if (triggers !== undefined) return triggers;
  const matched = CHAIN_PATH.exec(url.pathname);
  if (matched === null) throw agentXError("NOT_FOUND", "that isn't available yet");
  const [, rawId, sub, rawVersion] = matched;
  const method = request.method;
  if (rawId === undefined) {
    if (method === "GET") return listChains(deps, caller, url);
    if (method === "POST") return createChain(deps, caller, jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  const parsed = ChainIdSchema.safeParse(rawId);
  if (!parsed.success) throw notFound();
  const chainId = parsed.data;
  if (sub === undefined) {
    if (method === "GET") return getChain(deps, caller, chainId);
  } else if (rawVersion !== undefined) {
    if (sub === "versions" && method === "GET") return getVersion(deps, caller, chainId, Number(rawVersion));
  } else {
    const body = () => jsonBody(request);
    if (sub === "draft" && method === "GET") return getDraft(deps, caller, chainId);
    if (sub === "draft" && method === "PUT") return putDraft(deps, caller, chainId, body());
    if (sub === "runs" && method === "POST") return startRun(deps, caller, chainId, body());
    if (sub === "publish" && method === "POST") return publishChain(deps, caller, chainId, body());
    if (sub === "versions" && method === "GET") return listVersions(deps, caller, chainId);
    if (sub === "rollback" && method === "POST") return rollbackChain(deps, caller, chainId, body());
    if (sub === "archive" && method === "POST") return setArchived(deps, caller, chainId, body(), true);
    if (sub === "unarchive" && method === "POST") return setArchived(deps, caller, chainId, body(), false);
    if (sub === "shares" && method === "GET") return getShares(deps, caller, chainId);
    if (sub === "shares" && method === "PUT") return putShares(deps, caller, chainId, body());
    if (sub === "owner" && method === "PUT") return putOwner(deps, caller, chainId, body());
    if (sub === "accountable" && method === "PUT") return putAccountable(deps, caller, chainId, body());
    if (sub === "budget" && method === "PUT") return putBudget(deps, caller, chainId, body());
  }
  throw agentXError("NOT_FOUND", "route not found");
}

// ---- what confirming does

const STALE_DRAFT = "The draft changed after this was asked. Publish again.";
const stale = (message: string) => agentXError("CHAIN_REVISION_CONFLICT", message);

type ChainApprovalDeps = ApprovalDependencies & { chains?: ChainStore; chainTriggers?: ChainTriggerHooks };

function chainsOf(deps: ChainApprovalDeps): ChainStore {
  if (deps.chains === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "chains are not set up in this deployment");
  return deps.chains;
}

/** Who confirmed it. A record nobody has decided is never applied: the events would credit the person who asked. */
function decider(record: ApprovalRecord): string {
  if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
  return record.decidedBy;
}

async function liveChain(deps: ChainApprovalDeps, record: ApprovalRecord, chainId: string): Promise<ChainRecord> {
  const chain = await chainsOf(deps).get(record.orgId, chainId);
  if (chain === undefined) throw notFound();
  if (chain.status === "archived") throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} is archived, so it can't be changed. Unarchive it first.`);
  return chain;
}

async function confirmPublish(deps: ChainApprovalDeps, record: ApprovalRecord): Promise<void> {
  const by = decider(record);
  const subject = record.subject as Extract<ChainChangeSubject, { kind: "chain_publish" }>;
  const chains = chainsOf(deps);
  const chain = await liveChain(deps, record, subject.chainId);
  if (chain.currentVersion !== subject.expectedCurrentVersion) throw stale("The published version changed after this was asked. Publish again.");
  const draft = await chains.getDraft(record.orgId, chain.chainId);
  if (draft === undefined || draft.revision !== subject.draftRevision || chain.draftRevision !== subject.draftRevision) throw stale(STALE_DRAFT);
  // The pins are worked out again, as the person who asked would see them now: an agent that moved since changes the digest.
  const asker: AgentCaller = { orgId: record.orgId, developerId: record.requestedBy, orgRole: await orgRoleOf(deps, record.orgId, record.requestedBy) ?? "member" };
  const checked = await validateChainForPublish(deps, asker, record.orgId, draft.definition);
  const [problem] = checked.problems;
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", formatChainProblem(problem));
  if (chainDigest(checked.pinned) !== subject.digest) throw stale(STALE_DRAFT);
  await chains.publish({
    orgId: record.orgId, chainId: chain.chainId, expectedDraftRevision: subject.draftRevision, pinned: checked.pinned, digest: subject.digest,
    guardrailsRevision: checked.guardrailsRevision, by, expectedCurrentVersion: subject.expectedCurrentVersion ?? null, safety: "less_safe",
    ...(subject.note === undefined ? {} : { note: subject.note }),
  });
  await deps.chainTriggers?.recheckTriggersForTarget(record.orgId, { kind: "chain", chainId: chain.chainId });
}

async function confirmRollback(deps: ChainApprovalDeps, record: ApprovalRecord): Promise<void> {
  const by = decider(record);
  const subject = record.subject as Extract<ChainChangeSubject, { kind: "chain_rollback" }>;
  const chains = chainsOf(deps);
  const chain = await liveChain(deps, record, subject.chainId);
  if (chain.currentVersion !== subject.expectedCurrentVersion) throw stale("The published version changed after this was asked. Roll back again.");
  const target = await chains.getVersion(record.orgId, chain.chainId, subject.version);
  if (target === undefined || target.digest !== subject.digest) throw stale("That version changed after this was asked. Roll back again.");
  // As the person who asked would see it now: their use of the agents, and the guardrails as they are.
  const asker: AgentCaller = { orgId: record.orgId, developerId: record.requestedBy, orgRole: await orgRoleOf(deps, record.orgId, record.requestedBy) ?? "member" };
  const checked = await validatePinnedChainForOrg(deps, asker, record.orgId, target.definition);
  const [problem] = checked.problems;
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", formatChainProblem(problem));
  await chains.rollback({ orgId: record.orgId, chainId: chain.chainId, version: subject.version, expectedCurrentVersion: subject.expectedCurrentVersion, guardrailsRevision: checked.guardrailsRevision, by });
  await deps.chainTriggers?.recheckTriggersForTarget(record.orgId, { kind: "chain", chainId: chain.chainId });
}

async function confirmShare(deps: ChainApprovalDeps, record: ApprovalRecord): Promise<void> {
  const by = decider(record);
  const subject = record.subject as Extract<ChainChangeSubject, { kind: "chain_share" }>;
  const chain = await liveChain(deps, record, subject.chainId);
  if ((chain.sharesRevision ?? 0) !== subject.expectedSharesRevision) throw stale("Who this chain is shared with changed after this was asked. Share again.");
  await setChainShares({ ...deps, store: chainsOf(deps) }, { orgId: record.orgId, chainId: chain.chainId, shares: subject.shares, by });
}

/** Whoever holds `manage` on the chain now: its owner, an accountable or managing maintainer of the owning project, or an org owner or admin (R68). */
async function managesChain(deps: ChainApprovalDeps, record: ApprovalRecord, caller: AgentCaller): Promise<boolean> {
  const chainId = (record.kind === "change" ? (record.subject as { chainId?: unknown }).chainId : undefined);
  if (caller.orgId !== record.orgId || typeof chainId !== "string" || deps.chains === undefined) return false;
  const chain = await deps.chains.get(record.orgId, chainId);
  return chain !== undefined && atLeast(await chainAccess({ ...deps, store: deps.chains }, caller, chain), "manage");
}

/** Registers what Task 4 makes confirmable: the `chain_publish` rule and the handlers for a publish and a rollback. Safe to call more than once. */
export function registerChainApprovals(): void {
  registerApproverRule("chain_publish", (deps, record, caller) => managesChain(deps, record as ApprovalRecord, caller));
  registerApprovalSubjectHandler("chain_publish", (deps, record) => confirmPublish(deps, record as ApprovalRecord));
  registerApprovalSubjectHandler("chain_rollback", (deps, record) => confirmRollback(deps, record as ApprovalRecord));
  registerApprovalSubjectHandler("chain_share", (deps, record) => confirmShare(deps, record as ApprovalRecord));
}

registerChainApprovals();
