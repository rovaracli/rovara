// The company's rules for local agents (Plan 5 Task 17): whether people may run agents on their own Macs under Rovara, which tools, and on which projects.
// One document at `orgSettingsKey(orgId, "LOCAL_AGENTS")` with a revision. Until an owner or admin writes it the default applies (everything allowed). A
// document that is there but can't be read is never read as the default: it refuses with a retryable 503, so a broken rule can't open what it was set to close.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_NAME_PATTERN, LOCAL_TOOLS, agentXError, canonicalJson, localAgentsNotAllowedOnProjectMessage, localToolNotAllowedMessage, type OrgId } from "@rovara-code/contracts";
import { LOCAL_AGENTS_CONFLICT_MESSAGE, LOCAL_AGENTS_NEED_PROJECT_MESSAGE, LocalAgentPolicySchema, PutLocalAgentsBodySchema, defaultLocalAgentPolicy, normalizeLocalAgentPolicy, orgSettingsKey, type AuditEventInput, type LocalAgentPolicy, type StoredLocalAgentPolicy } from "@agentx/cloud-contracts";
import { commit, readRequest, type Item, type RequestMark, type TransactItem } from "../agents/table-writes.js";
import { auditLocalAgentsPolicyChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { invalidBody, type DeviceCaller, type DeviceDependencies } from "./store.js";

const UNREADABLE = "Your company's rules for local agents can't be read right now. Try again in a minute, or ask a Rovara admin to look at them.";

// ---- reading

/** The rule and its revision: the default at revision 0 while it has never been written. A stored document that doesn't read is a retryable 503, never the default. */
export async function readLocalAgentPolicyWithRevision(deps: DeviceDependencies, orgId: OrgId): Promise<StoredLocalAgentPolicy> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgSettingsKey(orgId, "LOCAL_AGENTS"), ConsistentRead: true })) as { Item?: Item };
  const item = response.Item;
  if (item === undefined) return { policy: defaultLocalAgentPolicy(), revision: 0 };
  const parsed = LocalAgentPolicySchema.safeParse({ allowed: item["allowed"], tools: item["tools"], projects: item["projects"] });
  const revision = item["revision"];
  if (!parsed.success || item["orgId"] !== orgId || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))({ event: "local_agents.policy_unreadable", orgId });
    throw agentXError("RUNTIME_UNAVAILABLE", UNREADABLE);
  }
  return { policy: parsed.data, revision };
}

export async function readLocalAgentPolicy(deps: DeviceDependencies, orgId: OrgId): Promise<LocalAgentPolicy> {
  return (await readLocalAgentPolicyWithRevision(deps, orgId)).policy;
}

// ---- the check

/**
 * Refuses a tool, or a project, the company hasn't allowed: `LOCAL_AGENT_NOT_ALLOWED` with the tool's text (also while local agents are off altogether) or the
 * project's. The tool is checked first; a session with no project passes only a rule that doesn't list projects (`"all"`). A tool the product doesn't know, or a project that
 * isn't a name, is refused as `CONFIG_INVALID` without repeating it.
 */
export function checkLocalAgentAllowed(policy: LocalAgentPolicy, tool: string, project?: string): void {
  if (!(LOCAL_TOOLS as readonly string[]).includes(tool)) throw agentXError("CONFIG_INVALID", "tool: is not a tool Rovara knows");
  if (project !== undefined && !AGENTX_NAME_PATTERN.test(project)) throw agentXError("CONFIG_INVALID", "project: is not a valid project name");
  if (!policy.allowed || !policy.tools.includes(tool as (typeof LOCAL_TOOLS)[number])) throw agentXError("LOCAL_AGENT_NOT_ALLOWED", localToolNotAllowedMessage(tool));
  // A rule that lists projects (even none) holds a session with no project too.
  if (project === undefined && policy.projects !== "all") throw agentXError("LOCAL_AGENT_NOT_ALLOWED", LOCAL_AGENTS_NEED_PROJECT_MESSAGE);
  if (project !== undefined && policy.projects !== "all" && !policy.projects.includes(project)) throw agentXError("LOCAL_AGENT_NOT_ALLOWED", localAgentsNotAllowedOnProjectMessage(project));
}

// ---- changing

const isAdmin = (caller: DeviceCaller) => caller.orgRole === "owner" || caller.orgRole === "admin";
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** The most characters a project list takes in an event's details (the ledger's per-field limit); a longer list is cut and says so. */
const DETAIL_LIST_MAX = 500;
const detailList = (names: string[]): string => {
  const joined = names.join(",");
  return joined.length <= DETAIL_LIST_MAX ? joined : `${joined.slice(0, DETAIL_LIST_MAX - 3)}...`;
};

/**
 * One `local_agents.policy_changed` event for each field of the rule that the write changes (Task 22), with the stored revision as the occurrence and the field as an id part.
 * The facts are fixed words: a flag, the tools' own names or `none`, and `all` or the number of projects; the project names are personal data and go only in the sealed details.
 */
function policyChangedEvents(orgId: OrgId, developerId: string, at: string, revision: number, from: LocalAgentPolicy, to: LocalAgentPolicy): AuditEventInput[] {
  const base = { orgId, actor: auditActorOf(developerId), occurredAt: at, occurrence: String(revision) };
  const events: AuditEventInput[] = [];
  if (from.allowed !== to.allowed) events.push(auditLocalAgentsPolicyChanged({ ...base, field: "allowed", from: from.allowed, to: to.allowed }));
  if (canonicalJson(from.tools) !== canonicalJson(to.tools)) {
    const words = (tools: readonly string[]) => (tools.length === 0 ? "none" : tools.join(","));
    events.push(auditLocalAgentsPolicyChanged({ ...base, field: "tools", from: words(from.tools), to: words(to.tools) }));
  }
  if (canonicalJson(from.projects) !== canonicalJson(to.projects)) {
    const count = (projects: LocalAgentPolicy["projects"]) => (projects === "all" ? "all" : projects.length);
    const names = (projects: LocalAgentPolicy["projects"]) => (projects === "all" ? "all" : detailList(projects));
    events.push(auditLocalAgentsPolicyChanged({
      ...base, field: "projects", from: count(from.projects), to: count(to.projects),
      details: [{ subject: "org", fields: { projectsFrom: names(from.projects), projectsTo: names(to.projects) } }],
    }));
  }
  return events;
}

/**
 * `PUT /v1/app/org/local-agents`: an owner or admin sets the rule, naming the revision they read (0 while it has never been written). A stale revision is
 * `AGENT_REVISION_CONFLICT`. The document, its revision, the audit items (one per changed field) and the request's item are written in one transaction; the same request
 * again answers the first outcome and writes nothing, and a change that changes nothing writes only the request's item and keeps the revision.
 */
export async function putLocalAgentPolicy(deps: DeviceDependencies, caller: DeviceCaller, body: unknown): Promise<StoredLocalAgentPolicy> {
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", "Only an org owner or admin can change your company's rules for local agents.");
  const parsed = PutLocalAgentsBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  const input = parsed.data;
  const next = normalizeLocalAgentPolicy(input.policy);
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId: input.requestId, fingerprint: sha256({ route: "local_agents_put", revision: input.revision, policy: next }) };
  const replay = await earlierAnswer(deps, mark);
  if (replay !== undefined) return replay;

  const current = await readLocalAgentPolicyWithRevision(deps, caller.orgId);
  if (current.revision !== input.revision) throw agentXError("AGENT_REVISION_CONFLICT", LOCAL_AGENTS_CONFLICT_MESSAGE);

  const key = orgSettingsKey(caller.orgId, "LOCAL_AGENTS");
  const at = new Date(deps.now()).toISOString();
  const unchanged = canonicalJson(normalizeLocalAgentPolicy(current.policy)) === canonicalJson(next);
  const revisionIs = current.revision === 0
    ? { ConditionExpression: "attribute_not_exists(pk)" }
    : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": current.revision } };
  const stored: StoredLocalAgentPolicy = { policy: unchanged ? current.policy : next, revision: unchanged ? current.revision : current.revision + 1 };
  const item: TransactItem = unchanged
    ? { ConditionCheck: { TableName: deps.tableName, Key: key, ...revisionIs } }
    : {
      Put: {
        TableName: deps.tableName,
        Item: { ...key, entityType: "ORG_LOCAL_AGENTS", orgId: caller.orgId, ...next, revision: stored.revision, updatedBy: caller.developerId, updatedAt: at },
        ...revisionIs,
      },
    };
  const events = unchanged ? [] : await tryAuditEvents(deps, () => policyChangedEvents(caller.orgId, caller.developerId, at, stored.revision, normalizeLocalAgentPolicy(current.policy), next));
  try {
    await commit(deps, [item, ...events.flatMap((event) => auditPending(deps, event))], (failed) => (failed.has(0) ? agentXError("AGENT_REVISION_CONFLICT", LOCAL_AGENTS_CONFLICT_MESSAGE) : undefined), mark, stored);
  } catch (error) {
    // Lost to the same request running at the same time: its answer is this one's.
    if ((error as { code?: string }).code === "IDEMPOTENCY_CONFLICT") {
      const won = await earlierAnswer(deps, mark);
      if (won !== undefined) return won;
    }
    throw error;
  }
  await flushAuditEvents(deps, events);
  return stored;
}

async function earlierAnswer(deps: DeviceDependencies, mark: RequestMark): Promise<StoredLocalAgentPolicy | undefined> {
  const earlier = await readRequest(deps, mark.orgId, mark.developerId, mark.requestId);
  if (earlier === undefined) return undefined;
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  return earlier.result as StoredLocalAgentPolicy;
}
