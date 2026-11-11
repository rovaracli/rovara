import { nativeSnapshotConditions } from "../org/native-snapshot-conditions.js";
import type { OwnerFinancialTerms } from "./owner-approval-terms.js";
// Plan 3 Task 28: the budget settings the spend engine reads. A scope's limit is its base (the org's, a member's, a project's, an agent's
// own) plus the month's top-up, held to the guardrails; `effectiveLimits` answers it for any list of scopes. This file also holds the
// project AI settings, the org's spend policy and the one monthly total each person's agent budgets count against. Task 31's `admitWork`
// reads the limits, Task 32's requests raise them and Task 33's top-ups add to them.
import { projectAiCallerCheck } from "./project-ai-identity.js";
import { grantRoleOf } from "../developer/project-roles.js";
import { projectAiLifecycleChecks } from "./project-ai-authority.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_PLANNING_LIMIT_USD, sameJsonContent, agentKey, agentXError, builtinSettingsKey, chainKey, isBuiltinAgentId, projectMemberKey, type AgentGuardrails, type OrgId } from "@rovara-code/contracts";
import { ProjectAiSettingsSchema, TaskStopProjectPolicySchema, TaskStopPendingChangeSchema, SpendPolicySchema, TRIAL_LIMITS_R49, defaultProjectAiSettings, defaultSpendPolicy, orgSettingsKey, ownerBudgetKey, projectAiKey, scopeKey, type BudgetScope, type ProjectAiSettings, type SpendPolicy } from "@agentx/cloud-contracts";
import { budgetActorChecks, budgetActorRefused, type BudgetActor } from "../agents/budget-authority.js";
import { readGuardrails } from "../agents/guardrails.js";
import type { OwnerShare } from "./owner-total.js";
import type { AgentRecord, BuiltinSettings, OwnerCap } from "../agents/store.js";
import { Aliases, commit, coded, type Item, type RequestMark, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { memberLimitOf, readBudgets, type OrgBudgetSettings } from "../org/budget.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { auditActorOf, projectAiEvents, spendPolicyEvents } from "../audit/plan3-hooks.js";
import { cleanUsd, readTopUp, withTopUp } from "./top-ups.js";

/** What reading and writing the settings needs: the State table, and whether the install is a cloud one (it sets the placeholder budgets). */
export interface SpendSettingsDependencies {
  /** Native sign-in table selected by server wiring, never by the request. */
  projectAiSignInTableName?: string;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Where the org's plan is read: a trial org that never wrote a spend policy has R49's owner cap (Task 28's ruling). Without it no org is a trial. */
  orgs?: { getOrg(orgId: OrgId): Promise<{ plan?: string } | undefined> } | undefined;
  /** Ruling R47: true on a cloud install, whose orgs start with the placeholder monthly limits. */
  cloud?: boolean;
  /** The Audit Ledger's outbox; absent on a legacy install, where a change to the project AI settings or the spend policy records nothing. */
  audit?: AuditRuntime;
}

type Document = Record<string, unknown>;

/** Every settings write needs server-bound identity, including internal calls without an HTTP receipt. */
function settingsActorChecks(deps: SpendSettingsDependencies, orgId: OrgId, by: string, options: { actor?: BudgetActor; request?: RequestMark } = {}): TransactItem[] {
  if ((options.actor === undefined) ||
    (options.actor.developerId !== by) ||
    (options.request !== undefined && (options.request.orgId !== orgId || options.request.developerId !== by))) throw budgetActorRefused();
  return budgetActorChecks(deps.tableName, orgId, options.actor);
}


async function getItem(deps: SpendSettingsDependencies, key: { pk: string; sk: string }): Promise<Document | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Document };
  return response.Item;
}

const unreadable = (what: string) => agentXError("CONFIG_INVALID", `${what} can't be read; ask a Rovara admin to look at them`);

// ---- project AI settings

export interface StoredProjectAi {
  settings: ProjectAiSettings;
  /** The revision a change must name: 0 while the project has never set any. */
  revision: number;
}

const revisionOf = (item: Document): number | undefined => (typeof item["revision"] === "number" && Number.isInteger(item["revision"]) && item["revision"] >= 1 ? item["revision"] : undefined);

/** A project's AI settings and their revision. A document that doesn't read is an error: falling back to the defaults would quietly undo what an admin set. */
export async function readProjectAiWithRevision(deps: SpendSettingsDependencies, orgId: OrgId, project: string): Promise<StoredProjectAi> {
  return parseProjectAiWithRevision(await getItem(deps, projectAiKey(orgId, project)), project);
}

/** Shared canonical validation of a single already-read project settings snapshot. */
export function parseProjectAiWithRevision(item: Document | undefined, project: string): StoredProjectAi {
  if (item === undefined) return { settings: defaultProjectAiSettings(), revision: 0 };
  const { monthlyBudgetUsd, projectPays, sourceOrder, planningLimitUsd, memberAcceptRunLimitUpToUsd, taskStopPolicy } = item;
  if (Object.hasOwn(item, "taskStopPolicy") && !TaskStopProjectPolicySchema.safeParse(taskStopPolicy).success) {
    throw agentXError("CONFIG_INVALID", `The per-task stop for project ${project} is invalid. Ask an org owner or admin to fix it before starting work.`);
  }
  const parsed = ProjectAiSettingsSchema.safeParse({
    ...(taskStopPolicy === undefined ? {} : { taskStopPolicy }),
    projectPays, ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }), ...(sourceOrder === undefined ? {} : { sourceOrder }), ...(planningLimitUsd === undefined ? {} : { planningLimitUsd }),
    ...(memberAcceptRunLimitUpToUsd === undefined ? {} : { memberAcceptRunLimitUpToUsd }),
  });
  const revision = revisionOf(item);
  if (!parsed.success || revision === undefined) throw unreadable(`${project}'s AI settings`);
  return { settings: parsed.data, revision };
}

export async function readProjectAi(deps: SpendSettingsDependencies, orgId: OrgId, project: string): Promise<ProjectAiSettings> {
  return (await readProjectAiWithRevision(deps, orgId, project)).settings;
}

const changedUnderYou = (what: string) => coded("AGENT_REVISION_CONFLICT", `Someone else changed ${what}. Reload them and make your change again.`);

/** The Put of a settings document that applies only while its revision is still `expected` (0: it was never written). */
function putRevised(table: TableInput, key: { pk: string; sk: string }, entityType: string, fields: Item, expected: number): TransactItem {
  return {
    Put: {
      TableName: table.tableName,
      Item: { ...key, entityType, ...fields, revision: expected + 1 },
      ...(expected === 0
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expected } }),
    },
  };
}

/**
 * The figures an event compares with, read when the caller did not pass them: only if they are at the revision the write is conditioned on. Another
 * revision means the write is about to be refused, and its "from" would describe a document the write never replaces, so no event is built (the
 * throw is the hook's to swallow: the action goes on, and the write's own condition decides it).
 */
async function settingsAt<S extends { revision: number }, T>(expected: number, read: () => Promise<S>, pick: (stored: S) => T): Promise<T> {
  const stored = await read();
  if (stored.revision !== expected) throw coded("AGENT_REVISION_CONFLICT", "the settings moved since they were read");
  return pick(stored);
}

/**
 * Makes `settings` the project's AI settings, in one transaction with the request's own item when `options.request` is given (R18). It
 * applies only while the document is at `options.expectedRevision` (by default the revision read now). Who may, and whether the values
 * fit the org, are the caller's checks.
 */
export async function writeProjectAi(
  deps: SpendSettingsDependencies & { now: () => number },
  orgId: OrgId,
  project: string,
  settings: ProjectAiSettings,
  by: string,
  options: { actor: BudgetActor; /** Legacy internal source option; this flow permits only the caller’s own identity. */ projectGrantDeveloperId?: string; expectedRevision?: number; request?: RequestMark; /** Optional audit comparison; preservation always reads the canonical settings. */ before?: ProjectAiSettings },
): Promise<StoredProjectAi> {
  const checks = settingsActorChecks(deps, orgId, by, options);
  // A supplied audit "before" is not authority to discard newer money intent.
  const original = await getItem(deps, projectAiKey(orgId, project));
  const current = parseProjectAiWithRevision(original, project);
  if (original?.pendingTaskStopChange !== undefined && !TaskStopPendingChangeSchema.safeParse(original.pendingTaskStopChange).success) throw agentXError("CONFIG_INVALID", "The pending Spending change is unreadable.");
  if (options.actor.role !== "owner" && options.actor.role !== "admin") {
    const unchangedFields = (value: ProjectAiSettings) => {
      const copy = { ...value }; delete copy.memberAcceptRunLimitUpToUsd; delete copy.taskStopPolicy; return copy;
    };
    if (!sameJsonContent(unchangedFields(settings), unchangedFields(current.settings))) throw budgetActorRefused();
    if (options.projectGrantDeveloperId !== undefined && options.projectGrantDeveloperId !== by) throw budgetActorRefused();
    checks.push(await projectAiCallerCheck(deps, by));
    const key = projectMemberKey(orgId, by, project), grant = await getItem(deps, key);
    if (grantRoleOf(grant) !== "maintainer") throw budgetActorRefused();
    const aliases = new Aliases();
    const condition = ["attribute_exists(pk)", ...["entityType", "ownerKey", "projectName", "grantId", "role", "projectRole", "grantedAt", "grantedBy"].map(field => grant?.[field] === undefined ? `attribute_not_exists(${aliases.name(field)})` : `${aliases.name(field)} = ${aliases.value(grant[field])}`)].join(" AND ");
    checks.push({ ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: condition, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } });
  }
  const lifecycle = await projectAiLifecycleChecks(deps, orgId, project);
  const expected = options.expectedRevision ?? current.revision;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) {
    throw agentXError("CONFIG_INVALID", "expectedRevision: cannot advance this settings revision");
  }
  if (current.revision !== expected) throw changedUnderYou(`${project}'s AI settings`);
  if (settings.taskStopPolicy !== undefined) {
    const candidate = TaskStopProjectPolicySchema.safeParse(settings.taskStopPolicy);
    if (!candidate.success || !sameJsonContent(candidate.data, current.settings.taskStopPolicy)) {
      throw agentXError("CONFIG_INVALID", "taskStopPolicy: changes require the reviewed task-stop policy writer");
    }
  }
  const preserved: ProjectAiSettings = { ...settings };
  delete preserved.taskStopPolicy;
  if (current.settings.taskStopPolicy !== undefined) preserved.taskStopPolicy = current.settings.taskStopPolicy;
  const updatedAt = new Date(deps.now()).toISOString();
  // One `budget.changed` for each money limit that moved. The write commits once per revision, so the revision is each event's occurrence.
  const events = await tryAuditEvents(deps, async () => projectAiEvents({
    orgId, actor: auditActorOf(by), occurredAt: updatedAt, project, revision: expected + 1, after: preserved,
    before: options.before ?? current.settings,
  }));
  const metadata = Object.fromEntries(["orgId", "project", "pendingTaskStopChange", "lastTaskStopChange", "seedProvenance"].filter(field => original?.[field] !== undefined).map(field => [field, original![field]]));
  const item = putRevised(deps, projectAiKey(orgId, project), "PROJECT_AI", { ...preserved, ...metadata, updatedBy: by, updatedAt }, expected);
  if (item.Put !== undefined) {
    const source = nativeSnapshotConditions(deps.tableName, [projectAiKey(orgId, project)], [original], ["taskStopPolicy", "pendingTaskStopChange", "orgId", "project", "seedProvenance"])[0]!.ConditionCheck!;
    // Upgrade seeds and pending proposals do not advance the financial revision.
    // Fence their exact presence and the original settings with this monthly write.
    item.Put.ConditionExpression = `(${item.Put.ConditionExpression}) AND (${source.ConditionExpression})`;
    const names = { ...item.Put.ExpressionAttributeNames, ...source.ExpressionAttributeNames };
    const values = { ...item.Put.ExpressionAttributeValues, ...source.ExpressionAttributeValues };
    if (Object.keys(names).length > 0) item.Put.ExpressionAttributeNames = names;
    if (Object.keys(values).length > 0) item.Put.ExpressionAttributeValues = values;
  }
  const items = [item, ...events.flatMap((event) => auditPending(deps, event))];
  const actorStart = items.length;
  await commit(deps, [...items, ...checks, ...lifecycle], (failed) => [...failed].some(index => index >= actorStart && index < actorStart + checks.length) ? budgetActorRefused() : [...failed].some(index => index >= actorStart + checks.length && index < actorStart + checks.length + lifecycle.length) ? coded("PROJECT_REVISION_MISMATCH", "The project registration or status changed. Reload and review your settings again.") : changedUnderYou(`${project}'s AI settings`), options.request, { settings: preserved, revision: expected + 1 });
  await flushAuditEvents(deps, events);
  return { settings: preserved, revision: expected + 1 };
}

/** What a change to a project's AI settings names: a number, list or flag sets it, `null` clears it, and what is left out stays. */
export interface ProjectAiChange {
  monthlyBudgetUsd?: number | null;
  projectPays?: boolean;
  sourceOrder?: ProjectAiSettings["sourceOrder"] | null;
  planningLimitUsd?: { QUICK?: number | null; FULL?: number | null };
  memberAcceptRunLimitUpToUsd?: number | null;
}

/** The settings with the change applied, checked against the schema (ranges, no repeated source). CONFIG_INVALID names the first field that is wrong. */
export function applyProjectAiChange(current: ProjectAiSettings, change: ProjectAiChange): ProjectAiSettings {
  const monthlyBudgetUsd = change.monthlyBudgetUsd === undefined ? current.monthlyBudgetUsd : change.monthlyBudgetUsd ?? undefined;
  const sourceOrder = change.sourceOrder === undefined ? current.sourceOrder : change.sourceOrder ?? undefined;
  const limits = { ...current.planningLimitUsd };
  for (const path of ["QUICK", "FULL"] as const) {
    const named = change.planningLimitUsd?.[path];
    if (named === null) delete limits[path];
    else if (named !== undefined) limits[path] = named;
  }
  const memberAccepts = change.memberAcceptRunLimitUpToUsd === undefined ? current.memberAcceptRunLimitUpToUsd : change.memberAcceptRunLimitUpToUsd ?? undefined;
  const parsed = ProjectAiSettingsSchema.safeParse({
    ...(current.taskStopPolicy === undefined ? {} : { taskStopPolicy: current.taskStopPolicy }),
    projectPays: change.projectPays ?? current.projectPays,
    ...(memberAccepts === undefined ? {} : { memberAcceptRunLimitUpToUsd: memberAccepts }),
    ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }),
    ...(sourceOrder === undefined ? {} : { sourceOrder }),
    ...(Object.keys(limits).length === 0 ? {} : { planningLimitUsd: limits }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid"}`);
  }
  return parsed.data;
}

/** The path's planning limit: the project's own, else the default. */
export function planningLimit(settings: Partial<ProjectAiSettings>, path: "QUICK" | "FULL"): number {
  return settings.planningLimitUsd?.[path] ?? DEFAULT_PLANNING_LIMIT_USD[path];
}

/** The model sources a project tries, in order: its own order, else the org's (an absent value means the org order). */
export function projectSourceOrder(settings: Partial<ProjectAiSettings>, orgOrder: readonly string[]): readonly string[] {
  return settings.sourceOrder ?? orgOrder;
}

// ---- the org's spend policy

export interface StoredSpendPolicy {
  policy: SpendPolicy;
  revision: number;
}

const POLICY_FIELDS = ["leadApprovalThresholdUsd", "adminApprovalThresholdUsd", "runLimitMultiplier", "testingAllowanceUsd", "perTestCapUsd", "ownerAgentBudgetCapUsd"] as const;

/** The org's spend policy and its revision: the defaults while it has never been written. */
export async function readSpendPolicyWithRevision(deps: SpendSettingsDependencies, orgId: OrgId): Promise<StoredSpendPolicy> {
  const item = await getItem(deps, orgSettingsKey(orgId, "SPEND_POLICY"));
  return decodeSpendPolicySnapshot(item, item === undefined ? (await deps.orgs?.getOrg(orgId))?.plan : undefined);
}

/** Decode the same canonical policy from an existing atomic snapshot. */
export function decodeSpendPolicySnapshot(item: Record<string, unknown> | undefined, plan: unknown): StoredSpendPolicy {
  if (item === undefined) {
    const trial = plan === "trial";
    const policy = defaultSpendPolicy();
    return { policy: trial ? { ...policy, ownerAgentBudgetCapUsd: Math.min(policy.ownerAgentBudgetCapUsd, TRIAL_LIMITS_R49.ownerAgentBudgetCapUsd) } : policy, revision: 0 };
  }
  const parsed = SpendPolicySchema.safeParse(Object.fromEntries(POLICY_FIELDS.map((field) => [field, item[field]])));
  const revision = revisionOf(item);
  if (!parsed.success || revision === undefined) throw unreadable("your company's spend policy");
  return { policy: parsed.data, revision };
}

export async function readSpendPolicy(deps: SpendSettingsDependencies, orgId: OrgId): Promise<SpendPolicy> {
  return (await readSpendPolicyWithRevision(deps, orgId)).policy;
}

/** Makes `policy` the org's spend policy, as `writeProjectAi` does for a project. */
export async function writeSpendPolicy(
  deps: SpendSettingsDependencies & { now?: () => number },
  orgId: OrgId,
  policy: SpendPolicy,
  by: string,
  options: { actor: BudgetActor; expectedRevision?: number; request?: RequestMark; /** The policy the caller has just read at `expectedRevision`; read here when absent (only on an install with a ledger). */ before?: SpendPolicy },
): Promise<StoredSpendPolicy> {
  const checks = settingsActorChecks(deps, orgId, by, options);
  const now = deps.now ?? Date.now;
  const expected = options.expectedRevision ?? (await readSpendPolicyWithRevision(deps, orgId)).revision;
  const updatedAt = new Date(now()).toISOString();
  // One `spend_policy.changed` for each figure that moved, at the revision the write commits.
  const events = await tryAuditEvents(deps, async () => spendPolicyEvents({
    orgId, actor: auditActorOf(by), occurredAt: updatedAt, revision: expected + 1, after: policy,
    before: options.before ?? await settingsAt(expected, () => readSpendPolicyWithRevision(deps, orgId), (stored) => stored.policy),
  }));
  const item = putRevised({ ...deps, now }, orgSettingsKey(orgId, "SPEND_POLICY"), "ORG_SPEND_POLICY", { ...policy, updatedBy: by, updatedAt }, expected);
  const items = [item, ...events.flatMap((event) => auditPending(deps, event))];
  const actorStart = items.length;
  await commit({ ...deps, now }, [...items, ...checks], (failed) => [...failed].some(index => index >= actorStart && index < actorStart + checks.length) ? budgetActorRefused() : changedUnderYou("your company's spend policy"), options.request, { policy, revision: expected + 1 });
  await flushAuditEvents(deps, events);
  return { policy, revision: expected + 1 };
}

// ---- effective limits

/** What a reader can ask for, each read once per call. */
interface LimitRead {
  deps: SpendSettingsDependencies;
  orgId: OrgId;
  budgets(): Promise<OrgBudgetSettings>;
  guardrails(): Promise<AgentGuardrails>;
  policy(): Promise<SpendPolicy>;
}

/** A scope's limit: its base plus the month's `topUpUsd`, or undefined when it has no limit (R47). */
export type LimitReader<K extends BudgetScope["kind"] = BudgetScope["kind"]> = (read: LimitRead, scope: Extract<BudgetScope, { kind: K }>, topUpUsd: number) => Promise<number | undefined>;

async function agentBase(read: LimitRead, agentId: string): Promise<number | undefined> {
  const key = isBuiltinAgentId(agentId) ? builtinSettingsKey(read.orgId, agentId) : agentKey(read.orgId, agentId, "META");
  const amount = (await getItem(read.deps, key))?.["monthlyBudgetUsd"];
  return typeof amount === "number" && Number.isFinite(amount) ? amount : undefined;
}

async function chainBase(read: LimitRead, chainId: string): Promise<number | undefined> {
  const amount = (await getItem(read.deps, chainKey(read.orgId, chainId, "META")))?.["monthlyBudgetUsd"];
  return typeof amount === "number" && Number.isFinite(amount) ? amount : undefined;
}

export const LIMIT_READERS: { [K in BudgetScope["kind"]]: LimitReader<K> } = {
  org: async (read, _scope, topUp) => withTopUp((await read.budgets()).orgMonthlyUsd, topUp),
  member: async (read, scope, topUp) => withTopUp(memberLimitOf(await read.budgets(), scope.developerId), topUp),
  project: async (read, scope, topUp) => {
    const amount = (await readProjectAi(read.deps, read.orgId, scope.project)).monthlyBudgetUsd;
    return withTopUp(amount, topUp);
  },
  agent: async (read, scope, topUp) => {
    const limit = withTopUp(await agentBase(read, scope.agentId), topUp);
    // The guardrail holds the base and the top-up together: a top-up can't take an agent past what an agent may be given.
    return limit === undefined ? undefined : Math.min(limit, (await read.guardrails()).maxAgentMonthlyUsd);
  },
  // A chain is held to the same guardrail as an agent: its base and this month's top-up together stay within `maxAgentMonthlyUsd`.
  chain: async (read, scope, topUp) => {
    const limit = withTopUp(await chainBase(read, scope.chainId), topUp);
    return limit === undefined ? undefined : Math.min(limit, (await read.guardrails()).maxAgentMonthlyUsd);
  },
  testing: async (read, _scope, topUp) => cleanUsd((await read.policy()).testingAllowanceUsd + topUp),
};

/**
 * The limit of each scope for the month, keyed by `scopeKey`: base plus the month's top-up, an agent held to `maxAgentMonthlyUsd`, a
 * member's test runs at the testing allowance plus the top-up. A scope with no limit is in the map with `undefined` (R47). The visibility
 * counter `AGENT_USAGE#<agentId>` has no limit and is not a scope.
 */
export async function effectiveLimits(deps: SpendSettingsDependencies, input: { orgId: OrgId; month: string; scopes: readonly BudgetScope[] }): Promise<Map<string, number | undefined>> {
  const once = <T>(load: () => Promise<T>) => { let found: Promise<T> | undefined; return () => (found ??= load()); };
  const read: LimitRead = {
    deps, orgId: input.orgId,
    budgets: once(() => readBudgets(deps, input.orgId)),
    guardrails: once(() => readGuardrails(deps, input.orgId)),
    policy: once(() => readSpendPolicy(deps, input.orgId)),
  };
  const limits = new Map<string, number | undefined>();
  await Promise.all(input.scopes.map(async (scope) => {
    const reader = LIMIT_READERS[scope.kind] as LimitReader;
    limits.set(scopeKey(scope), await reader(read, scope, await readTopUp(deps, input.orgId, input.month, scope)));
  }));
  return limits;
}

/** An agent's own cap on one run: what it set, never above the guardrail's ceiling; undefined when it set none (no agent-level cap). */
export function effectiveMaxPerRun(record: AgentRecord | BuiltinSettings, guardrails: Pick<AgentGuardrails, "maxPerRunCeilingUsd">): number | undefined {
  return record.maxPerRunUsd === undefined ? undefined : Math.min(record.maxPerRunUsd, guardrails.maxPerRunCeilingUsd);
}

// ---- one total per owner

export { budgetOwnerOf } from "./owner-total.js";

/** What one person's active agents have as monthly budgets, added up. */
export async function readOwnerTotal(deps: SpendSettingsDependencies, orgId: OrgId, owner: string): Promise<number> {
  const total = (await getItem(deps, ownerBudgetKey(orgId, owner)))?.["totalUsd"];
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export interface OwnerBudgetCheck {
  /** Original native base-counter version; absent for an unreadable/missing source. */
  counterVersion?: number;
  /** The total now, the total with the change and the cap, in US dollars. */
  totalUsd: number;
  wouldBeUsd: number;
  capUsd: number;
  /** The revision of the spend policy the cap was read from; the write checks the policy is still at it. */
  policyRevision: number;
  ok: boolean;
}

/**
 * Whether one person's agent budgets may change by `deltaUsd`. A change that lowers or keeps the total always passes; a raise passes when
 * the total with it is at most the org's `ownerAgentBudgetCapUsd`, so landing exactly on the cap passes. Lowering the cap changes no
 * existing budget; it only gates later raises. The store makes the same test again inside the write (`ownerCap`), so two raises that
 * together pass the cap can't both apply. The write also checks the spend policy is still at the revision read here, so a cap an admin
 * lowers in between is not raced past. This is the counter alone (the agents' base budgets): Rovara's own moves are checked on it. A person's own
 * budget change is held to the effective total, top-ups included (`ownerBudgetRefusal` with `effective`, Task 33 fix round 1, I-1).
 */
export async function checkOwnerBudget(deps: SpendSettingsDependencies, input: { orgId: OrgId; owner: string; deltaUsd: number }): Promise<OwnerBudgetCheck> {
  const [counter, { policy, revision }] = await Promise.all([getItem(deps, ownerBudgetKey(input.orgId, input.owner)), readSpendPolicyWithRevision(deps, input.orgId)]);
  const totalUsd = typeof counter?.totalUsd === "number" && Number.isFinite(counter.totalUsd) ? counter.totalUsd : 0;
  const version = counter?.version === undefined ? 0 : counter.version;
  const counterVersion = counter !== undefined && Number.isInteger(version) && typeof version === "number" && version >= 0 && totalUsd >= 0 ? version : undefined;
  const capUsd = policy.ownerAgentBudgetCapUsd;
  const wouldBeUsd = cleanUsd(totalUsd + input.deltaUsd);
  return { totalUsd, wouldBeUsd, capUsd, policyRevision: revision, ...(counterVersion === undefined ? {} : { counterVersion }), ok: input.deltaUsd <= 0 || wouldBeUsd <= capUsd };
}

/**
 * Why a change that moves an agent's budget from `before` to `after` can't be made, in words for the person asking, or the cap to hold the
 * write to when it can. The shares name owners already read as their survivors. Only the owner `after` counts for is tested: a change that
 * lowers or keeps that owner's total always passes.
 *
 * Task 32 (PF27): an over-the-cap change is not refused: the route asks an org admin with an `owner_cap` request (`requestOwnerCap`) and answers 202,
 * and the admin's approval applies the stored change as an override of the cap. `over` carries the figures the request's words are made of.
 *
 * Task 33 fix round 1 (I-1): the cap is on the owner's effective total, base plus this month's top-ups. `effective` reads it (`effectiveOwnerCap` in
 * spend/requests.ts) with the owner counter's version, and the cap handed to the store carries both (`OwnerCap.seen`), so the write is held to the same
 * figure and can't race a top-up. Without it (an install with no top-ups) the counter alone is the total.
 *
 * Fix round 2 (N-1): an agent's own top-up for the month goes with it. When the change makes the agent count for a new owner (a move, a new accountable
 * maintainer, an unarchive), `carriedUsd` (its `readTopUp` now) joins that owner's total with the base, in the test and in `seen.extraUsd`, so the store's
 * condition (`counter + base ≤ cap − extra`) holds it too.
 */
export async function ownerBudgetRefusal(
  deps: SpendSettingsDependencies,
  orgId: OrgId,
  before: OwnerShare | undefined,
  after: OwnerShare | undefined,
  effective?: (owner: string) => Promise<{ totalUsd: number; counterUsd: number; version: number; month?: string }>,
  carriedUsd = 0,
): Promise<{ over: { owner: string; wouldBeUsd: number; capUsd: number; ownerFinancialTerms?: OwnerFinancialTerms } } | { ownerCap: OwnerCap }> {
  const joins = after !== undefined && before?.owner !== after.owner;
  const carried = joins ? carriedUsd : 0;
  const deltaUsd = after === undefined ? 0 : joins ? cleanUsd(after.usd + carried) : cleanUsd(after.usd - before!.usd);
  const owner = after?.owner;
  if (owner === undefined) {
    const { policy, revision } = await readSpendPolicyWithRevision(deps, orgId);
    return { ownerCap: { usd: policy.ownerAgentBudgetCapUsd, policyRevision: revision } };
  }
  if (effective !== undefined) {
    const { policy, revision } = await readSpendPolicyWithRevision(deps, orgId);
    const read = await effective(owner);
    const capUsd = policy.ownerAgentBudgetCapUsd;
    const wouldBeUsd = cleanUsd(read.totalUsd + deltaUsd);
    if (deltaUsd > 0 && wouldBeUsd > capUsd) return { over: { owner, wouldBeUsd, capUsd, ownerFinancialTerms: { version: 1, owner, month: read.month ?? new Date().toISOString().slice(0, 7), totalUsd: read.totalUsd, counterUsd: read.counterUsd, counterVersion: read.version, capUsd, policyRevision: revision, carriedUsd: carried, wouldBeUsd } } };
    return { ownerCap: { usd: capUsd, policyRevision: revision, seen: { owner, version: read.version, extraUsd: cleanUsd(read.totalUsd - read.counterUsd + carried) } } };
  }
  const check = await checkOwnerBudget(deps, { orgId, owner, deltaUsd });
  if (check.ok) return { ownerCap: { usd: check.capUsd, policyRevision: check.policyRevision } };
  return { over: { owner, wouldBeUsd: check.wouldBeUsd, capUsd: check.capUsd } };
}
