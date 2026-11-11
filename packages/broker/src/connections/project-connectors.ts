// Plan 3 Task 13: a project's maintainers attach the org's connections to it as connectors, from the app
// (`GET /v1/app/projects/{p}/connectors`, `PUT` and `DELETE /v1/app/projects/{p}/connectors/{name}`). Each change is a new immutable project revision,
// written through `registerProjectFor` (the same registration every revision goes through, its checks and live preflight included) and built from the
// revision the person saw. Rovara Cloud only: another install's connectors change with `agentx admin project register`.
//
// A connector that links a Linear, Jira or MCP connection names it by `credentialRef`, which must be a connection of the caller's own org of the same
// type; a tool approved to write needs a connection that may write. A tool newly approved to write (the stored revision had it as read, or not at all)
// is a widening (R9-3, R69): it writes nothing until a project maintainer or an org admin confirms it on the page, and then writes exactly that connector.
// Narrowing, removing tools and read-only changes apply at once.
//
// Every change carries a request item (R18) and the audit event in the same transaction as the project revision (`registerProjectFor`'s `extraItems`).
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentXError, AgentXNameSchema, ConnectionIdSchema, ConnectorConfigSchema, ConnectorNameSchema, agentXError, canonicalJson, connectionTakesSecret, projectAllows, type ConnectorConfig, type ConnectorPreflight, type OrgId, type RegistrationPreflight, projectArchivedMessage } from "@rovara-code/contracts";
import { ProjectDefinitionSchema, type ProjectDefinition, type StoredProjectDefinition } from "@agentx/cloud-contracts";
import { type AuditProof } from "@agentx/cloud-contracts";
import { orgRoleOf, resolveSurvivor, type AgentCaller } from "../agents/access.js";
import {
  confirmUrlFor,
  createPendingChange,
  pendingChangeFor,
  registerApprovalSubjectHandler,
  registerApproverRule,
  type ApprovalDependencies,
  type ApprovalRecord,
  type ConnectorWidenSubject,
} from "../agents/approvals.js";
import { roleOnProject } from "../agents/roster.js";
import { readRequest, requestMarkItem, commit, type RequestMark, type TransactItem } from "../agents/table-writes.js";
import { auditOccurrence, auditProjectConnectorChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { SETTINGS_STALE_MESSAGE, latestRevision, type LatestRevision } from "../org/project-settings.js";
import { DATADOG_TOOL_NAMES } from "../connectors/native/datadog.js";
import { GRAFANA_TOOL_NAMES } from "../connectors/native/grafana.js";
import { PAGERDUTY_TOOL_NAMES } from "../connectors/native/pagerduty.js";
import { CLOUDWATCH_TOOL_NAMES } from "../connectors/native/cloudwatch.js";
import { GITHUB_ACTIONS_TOOL_NAMES } from "../connectors/native/github-actions.js";
import { SENTRY_TOOL_NAMES } from "../connectors/native/sentry.js";
import { VERCEL_TOOL_NAMES } from "../connectors/native/vercel.js";
import type { OrgConnectionStore } from "./store.js";

/** What the project connector routes need beyond the approvals' dependencies; the broker builds it, and a deployment that is not Rovara Cloud sets `cloud: false`. */
export interface ProjectConnectorDependencies {
  /** Whether this install is Rovara Cloud: another install's connectors are changed by an administrator. */
  cloud: boolean;
  /** The org's connections (Task 12), which a connector's `credentialRef` names. Without it only a `github` connector can be saved. */
  connections?: Pick<OrgConnectionStore, "get">;
  /**
   * Registers one project revision (`registerProjectFor`, with no creator membership and the vendor preflight on), with `extraItems` in the same
   * transaction. `duplicate` is true when the revision was already registered, so none of the items was written.
   */
  registerRevision(
    actor: { orgId: OrgId; ownerKey: string },
    /** `credentialsChecked`: the connectors whose credential registration must find (a change leaves the others' connections for their own status, as a removal leaves them all). */
    input: { definition: ProjectDefinition; runtimeBinding: unknown; credentialsChecked: string[] },
    extraItems: TransactItem[],
  ): Promise<{ duplicate: boolean; preflight?: RegistrationPreflight }>;
  /** What the registration preflight says of each connector of a revision now, without registering it. */
  preflight(actor: { orgId: OrgId; ownerKey: string }, definition: StoredProjectDefinition): Promise<ConnectorPreflight[]>;
}

type Connectors = ProjectConnectorDependencies;

/** The dependencies a project connector function runs on: the approvals' (access, the State table, the page's origin) with the connector ones present. */
type Deps = ApprovalDependencies & { projectConnectors: Connectors };

export const isProjectConnectorRoute = (pathname: string): boolean => /^\/v1\/app\/projects\/[^/]+\/connectors(\/|$)/.test(pathname);

/** The connector types Plan 3 built: the ones that name an org connection, and GitHub through the org's GitHub App. */
const APP_CONNECTOR_TYPES = ["github", "linear", "jira", "mcp"] as const;

/** Plan 4 Task 12: the seven read-only connector types that watch a company's systems. */
export const NATIVE_CONNECTOR_TYPES = ["sentry", "datadog", "cloudwatch", "github-actions", "grafana", "vercel", "pagerduty"] as const;
export type NativeConnectorType = (typeof NATIVE_CONNECTOR_TYPES)[number];

/** Every type `PUT` accepts. */
const ACCEPTED_CONNECTOR_TYPES: readonly string[] = [...APP_CONNECTOR_TYPES, ...NATIVE_CONNECTOR_TYPES];

const isNativeType = (type: string): type is NativeConnectorType => (NATIVE_CONNECTOR_TYPES as readonly string[]).includes(type);

/**
 * The tools a project may approve on each native type: the tools its connector offers, all of them reads. A type's list is empty until its task
 * (13 to 17) lists the tools of its connector, and until then no tool of the type is accepted. A tool outside the list is refused when a connector is saved
 * and again when a confirmed change is applied, so a tool a later release stops offering is not approved by an old request.
 */
export const PROJECT_CONNECTOR_TOOLS: Record<NativeConnectorType, readonly string[]> = {
  sentry: SENTRY_TOOL_NAMES, datadog: DATADOG_TOOL_NAMES, cloudwatch: CLOUDWATCH_TOOL_NAMES, "github-actions": GITHUB_ACTIONS_TOOL_NAMES, grafana: GRAFANA_TOOL_NAMES, vercel: VERCEL_TOOL_NAMES, pagerduty: PAGERDUTY_TOOL_NAMES,
};

const PRIVATE_INSTALL_MESSAGE = "ask an administrator to change this project's connectors with agentx admin project register";
const NOT_SET_UP_MESSAGE = "project connectors are not set up in this deployment";

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);

function requireConnectorDeps(deps: ApprovalDependencies): Deps {
  if (deps.projectConnectors === undefined) throw agentXError("NOT_FOUND", NOT_SET_UP_MESSAGE);
  return deps as Deps;
}

// ---- bodies

const RequestIdSchema = z.string().uuid();
const PutBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(1), connector: z.unknown() }).strict();
const DeleteBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: z.number().int().min(1) }).strict();

/** The body, or CONFIG_INVALID naming the field and never an unknown field's name or a value. */
function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw invalid(`${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

/**
 * The connector in a body, as the schema of its type reads it. A path in a refusal is relative to the connector, as the plan's texts are
 * (`credentialRef: …`, `tools.<i>: …`); an unknown field's name is never repeated.
 */
function parseConnector(raw: unknown, name: string): ConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("connector: must be an object");
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || !ACCEPTED_CONNECTOR_TYPES.includes(type)) {
    throw invalid(`type: a project connector is one of ${ACCEPTED_CONNECTOR_TYPES.join(", ")}`);
  }
  const parsed = ConnectorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "connector" : issue.path.join(".");
    throw invalid(`${path}: ${issue === undefined ? "is not valid" : issue.code === "unrecognized_keys" ? `has a field a ${type} connector does not take` : issue.message}`);
  }
  if (parsed.data.name !== name) throw invalid("name: must be the name in the path");
  return parsed.data;
}

// ---- what is stored

type StoredEntry = NonNullable<NonNullable<StoredProjectDefinition["integrations"]>["connectors"]>[number];

/** The connectors a revision holds, the feature 007 `githubMcp` policy read as a connector named `github` over every repository. */
function storedConnectors(definition: StoredProjectDefinition): StoredEntry[] {
  const legacy = definition.integrations?.githubMcp;
  if (legacy !== undefined) return [{ name: "github", type: "github", scopes: "all-repositories", tools: legacy.tools }];
  return [...(definition.integrations?.connectors ?? [])];
}

/**
 * The connectors a revision would hold with `next` in the place of the one called `name` (after the others when it is new; none, to remove it), and
 * the stored one it replaces. Every other stored entry must be one this release can write back: an entry of an unknown type is not rewritten.
 */
function rebuildConnectors(definition: StoredProjectDefinition, name: string, next: ConnectorConfig | undefined): { previous: StoredEntry | undefined; connectors: ConnectorConfig[] } {
  const entries = storedConnectors(definition);
  const connectors: ConnectorConfig[] = [];
  for (const entry of entries) {
    if (entry.name === name) {
      if (next !== undefined) connectors.push(next);
      continue;
    }
    const known = ConnectorConfigSchema.safeParse(entry);
    if (!known.success) throw invalid("this project has a connector this version of Rovara cannot change; ask Rovara support");
    connectors.push(known.data);
  }
  const previous = entries.find((entry) => entry.name === name);
  if (previous === undefined && next !== undefined) connectors.push(next);
  return { previous, connectors };
}

type Fields = Record<string, unknown>;

const article = (type: string) => (type === "mcp" || type === "asana" ? "an" : "a");

/**
 * Whether a stored connector is the same target as `next`: the same type and connection and, for MCP, the same endpoint and bind. A write tool
 * confirmed for one target says nothing about another, so a tool that keeps its name while the connection, type or address behind it changes is new.
 */
function targetMoved(previous: StoredEntry, next: ConnectorConfig): string | undefined {
  const before = previous as Fields;
  const after = next as Fields;
  if (before["type"] !== next.type) return `now ${article(next.type)} ${next.type} connector`;
  if (before["credentialRef"] !== after["credentialRef"]) return `now on connection ${String(after["credentialRef"])}`;
  if (next.type === "mcp") {
    if (before["endpoint"] !== after["endpoint"]) return "now at another address";
    if (canonicalJson(before["bind"] ?? null) !== canonicalJson(after["bind"] ?? null)) return "now bound to other values";
  }
  return undefined;
}

/** A list of strings from stored data, which may be absent. */
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const within = (inner: readonly string[], outer: readonly string[]): boolean => inner.every((value) => outer.includes(value));

/**
 * UNREACHABLE TODAY (review B-M1): `widenings()` returns nothing for a connector with no write tool, and every native schema refuses a write tool, so these
 * rules run only when a test casts a write tool past the schema. They are kept, and tested that way, for a later plan that lets a native type write; until
 * then a scope added to a native connector applies at once, as a scope added to any other read-only connector does.
 *
 * For each native type, whether a stored scope already reaches everything a new scope would, by what that type's scope names. A scope that asks for less
 * than the stored one (more Datadog tags, fewer PagerDuty services, a longer name prefix) is covered; one that asks for more or for something else is not.
 */
const NATIVE_SCOPE_COVERS: Readonly<Record<string, (stored: Fields, scope: Fields) => boolean>> = {
  sentry: (stored, scope) => stored["projectSlug"] === scope["projectSlug"],
  vercel: (stored, scope) => stored["projectId"] === scope["projectId"],
  pagerduty: (stored, scope) => within(stringsOf(scope["serviceIds"]), stringsOf(stored["serviceIds"])),
  // Every tag narrows a query, so a scope holding all of the stored tags (and more) reaches no more than it did.
  datadog: (stored, scope) => within(stringsOf(stored["tags"]), stringsOf(scope["tags"])),
  grafana: (stored, scope) => {
    // No folders means every folder; no data source means no metric query.
    const folders = stored["folderUids"] === undefined || (scope["folderUids"] !== undefined && within(stringsOf(scope["folderUids"]), stringsOf(stored["folderUids"])));
    return folders && (scope["datasourceUid"] === undefined || scope["datasourceUid"] === stored["datasourceUid"]);
  },
  cloudwatch: (stored, scope) => {
    // No log group prefixes means no log search; no alarm prefix means every alarm of the region.
    const newLogs = stringsOf(scope["logGroupPrefixes"]);
    const logs = newLogs.length === 0 || newLogs.every((prefix) => stringsOf(stored["logGroupPrefixes"]).some((held) => prefix.startsWith(held)));
    const held = stored["alarmNamePrefix"];
    const alarms = held === undefined || (typeof held === "string" && typeof scope["alarmNamePrefix"] === "string" && scope["alarmNamePrefix"].startsWith(held));
    return stored["region"] === scope["region"] && logs && alarms;
  },
};

/** The scopes of `next` that `previous` did not already cover, by what each names: a new alias, team, Jira site (or project), repository, Sentry project, tag set and so on. */
function addedScopes(previous: StoredEntry, next: ConnectorConfig): string[] {
  const before = (previous as Fields)["scopes"];
  if (next.type === "github" || next.type === "github-actions") {
    if (next.scopes === "all-repositories") return before === "all-repositories" ? [] : ["all repositories"];
    if (before === "all-repositories") return [];
    const known = new Set(Array.isArray(before) ? before as string[] : []);
    return next.scopes.filter((scope) => !known.has(scope)).map((scope) => `one more scope (${scope})`);
  }
  if (next.type === "asana") return [];
  const stored = Array.isArray(before) ? before as Fields[] : [];
  const aliases = new Set(stored.map((scope) => String(scope["alias"])));
  const covered = (scope: Fields): boolean => stored.some((old) => {
    if (next.type === "linear") return String(old["teamId"]).toLowerCase() === String(scope["teamId"]).toLowerCase();
    if (next.type === "jira") return String(old["cloudId"]).toLowerCase() === String(scope["cloudId"]).toLowerCase() && (old["projectKey"] === undefined || old["projectKey"] === scope["projectKey"]);
    if (isNativeType(next.type)) return Object.hasOwn(NATIVE_SCOPE_COVERS, next.type) && NATIVE_SCOPE_COVERS[next.type]!(old, scope);
    return canonicalJson(old["values"] ?? null) === canonicalJson(scope["values"] ?? null);
  });
  return (next.scopes as Fields[]).filter((scope) => !aliases.has(String(scope["alias"])) || !covered(scope)).map((scope) => `one more scope (${String(scope["alias"])})`);
}

/** Whether an MCP connector that writes now acts without a scope check that it had before (an ownership rule to the credential's own reach, or an acknowledgement turned on). */
function lostScopeCheck(previous: StoredEntry, next: ConnectorConfig): boolean {
  if (next.type !== "mcp") return false;
  const before = ((previous as Fields)["scoping"] ?? {}) as Fields;
  return next.scoping.mode === "credential" && (before["mode"] !== "credential" || (before["acknowledgeUnscopedWrites"] !== true && next.scoping.acknowledgeUnscopedWrites === true));
}

/**
 * A scoping rule without the words it shows people: the item's noun, and the message of each `refuse` and `require` entry. Only these paths are wording;
 * a name elsewhere (a tool called `message` in `references`, an argument called `message` in `lookup.arguments`) is part of what the rule enforces.
 */
function scopingWithoutWording(scoping: unknown): unknown {
  if (typeof scoping !== "object" || scoping === null || Array.isArray(scoping)) return scoping;
  const { itemNoun: _noun, itemNounPlural: _plural, ...rule } = scoping as Fields; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped: wording
  const entries = (list: unknown): unknown => (Array.isArray(list) ? (list as unknown[]).map((entry): unknown => {
    if (typeof entry !== "object" || entry === null) return entry;
    const { message: _message, ...kept } = entry as Fields; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped: wording
    return kept;
  }) : list);
  return { ...rule, ...(rule["refuse"] === undefined ? {} : { refuse: entries(rule["refuse"]) }), ...(rule["require"] === undefined ? {} : { require: entries(rule["require"]) }) };
}

/** The values of a list as a set of what they are, so order does not matter. */
const asSet = (values: unknown): Set<string> => new Set(Array.isArray(values) ? values.map((value) => canonicalJson(value)) : []);
const isSubset = (inner: Set<string>, outer: Set<string>): boolean => [...inner].every((value) => outer.has(value));

/**
 * How a write tool's limits (the arguments it may take, the values they may have) are looser than the confirmed tool's: `fewer` when a limit was dropped,
 * `looser` when one grew. A limit that is added or tightened is neither.
 */
function limitsLoosened(old: Fields, now: Fields): "fewer" | "looser" | undefined {
  let looser = false;
  const allowed = old["allowedArguments"];
  if (Array.isArray(allowed)) {
    if (!Array.isArray(now["allowedArguments"])) return "fewer";
    if (!isSubset(asSet(now["allowedArguments"]), asSet(allowed))) looser = true;
  }
  const values = old["argumentValues"];
  if (typeof values === "object" && values !== null) {
    const nowValues = (typeof now["argumentValues"] === "object" && now["argumentValues"] !== null ? now["argumentValues"] : {}) as Fields;
    for (const [argument, list] of Object.entries(values)) {
      if (!Object.hasOwn(nowValues, argument)) return "fewer";
      if (!isSubset(asSet(nowValues[argument]), asSet(list))) looser = true;
    }
  }
  return looser ? "looser" : undefined;
}

/** What changed in an MCP connector's guards that a person confirmed with its write tools: its scoping, other than wording, and the arguments that name an item or the requester. */
function mcpGuardsChanged(previous: StoredEntry, next: ConnectorConfig): string[] {
  if (next.type !== "mcp") return [];
  const before = previous as Fields;
  const after = next as Fields;
  const words: string[] = [];
  if (lostScopeCheck(previous, next)) words.push("act without a scope check");
  else if (canonicalJson(scopingWithoutWording(before["scoping"] ?? null)) !== canonicalJson(scopingWithoutWording(after["scoping"] ?? null))) words.push("act under different scope rules");
  if (canonicalJson(before["itemArguments"] ?? null) !== canonicalJson(after["itemArguments"] ?? null)) words.push("use other item arguments");
  if (canonicalJson(before["attributionKeys"] ?? null) !== canonicalJson(after["attributionKeys"] ?? null)) words.push("use other attribution keys");
  return words;
}

/**
 * What `next` makes newly able to write (R9-3, R69), in the words the page shows; nothing when it has no write tool. A write tool counts as already
 * confirmed only for the same target (type, connection, and for MCP endpoint and bind), where it was `write`, and with limits no looser than it had; and
 * on the same target a scope added, or an MCP connector's scoping, item arguments or attribution keys changed, widens what the confirmed tools reach, and turning
 * the requester footer off weakens who is recorded as asking.
 */
export function widenings(previous: StoredEntry | undefined, next: ConnectorConfig, project: string): string[] {
  const writes = next.tools.filter((tool) => tool.access === "write");
  if (writes.length === 0) return [];
  const where = `On ${project}, lets the ${next.name} connector's`;
  const moved = previous === undefined ? undefined : targetMoved(previous, next);
  const stored: unknown = previous === undefined || moved !== undefined ? undefined : (previous as Fields)["tools"];
  const before = new Map<string, Fields>();
  if (Array.isArray(stored)) for (const tool of stored as Fields[]) before.set(String(tool["name"]), tool);
  const words = writes.flatMap((tool) => {
    const old = before.get(tool.name);
    if (old?.["access"] === "write") {
      const loosened = limitsLoosened(old, tool);
      return loosened === undefined ? [] : [`${where} ${tool.name} tool make changes (${loosened} argument limits)`];
    }
    const note = moved !== undefined ? ` (${moved})` : old?.["access"] === "read" ? " (it could only read before)" : "";
    return [`${where} ${tool.name} tool make changes${note}`];
  });
  if (previous === undefined || moved !== undefined) return words;
  return [
    ...words,
    ...addedScopes(previous, next).map((scope) => `${where} write tools reach ${scope}`),
    ...mcpGuardsChanged(previous, next).map((change) => `${where} write tools ${change}`),
    // Writes from now on carry no "requested by" footer: reach does not grow, but the trail of who asked is weaker.
    ...((previous as Fields)["attribution"] !== false && (next as Fields)["attribution"] === false ? [`${where} write tools write without the requester footer`] : []),
  ];
}

// ---- checks

/** Whether the caller may change the project's connectors, in the order the settings route uses: no role is a 404, a role below maintainer a 403, then an install that is not Rovara Cloud. */
async function requireMayChange(deps: Deps, caller: AgentCaller, project: string): Promise<void> {
  const role = await roleOnProject(deps, caller, project);
  if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", `Only a maintainer of ${project} can change its connectors.`);
  if (!deps.projectConnectors.cloud) throw agentXError("FORBIDDEN", PRIVATE_INSTALL_MESSAGE);
}

/** The project's newest revision, read consistently, and the person's `expectedRevision` held against it. An archived project's settings are as they were when it was archived. */
async function loadCurrent(deps: Deps, orgId: OrgId, project: string, expectedRevision: number | undefined): Promise<LatestRevision> {
  if ((await readProjectMeta(deps, orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  const latest = await latestRevision(deps, orgId, project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if (expectedRevision !== undefined && latest.definition.revision !== expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  // The same refusal the settings route gives: a revision with an end-to-end policy or a setup approval is registered only with its approval.
  if (latest.definition.e2e !== undefined || latest.setupApproval !== undefined) {
    throw agentXError("FORBIDDEN", "this project carries an end-to-end policy or a setup approval that only an administrator can change; ask an administrator to change it with agentx admin project register");
  }
  return latest;
}

/**
 * Checks a connector against the org and the project as they are now: a GitHub connector's scopes are repositories of this project; any other names a
 * connection of this org of its own type that has a key saved, and a tool approved to write needs a connection that may write. Run when a connector is
 * saved and again when a confirmed widening is applied, so a connection removed or lowered since is felt. `holdsApproval`: the change is a narrowing of
 * the same target, which is let through even when its connection is gone.
 */
async function validateConnector(deps: Deps, orgId: OrgId, definition: StoredProjectDefinition, connector: ConnectorConfig, holdsApproval = false): Promise<void> {
  // A native type offers its own tools and no others, held or not: a list is never carried over from an older revision.
  if (isNativeType(connector.type)) {
    const offered = PROJECT_CONNECTOR_TOOLS[connector.type];
    const unlisted = connector.tools.findIndex((tool) => !offered.includes(tool.name));
    if (unlisted >= 0) throw invalid(`tools.${String(unlisted)}: ${connector.tools[unlisted]!.name} is not a ${connector.type} tool`);
  }
  if (connector.type === "github" || connector.type === "github-actions") {
    if (connector.scopes !== "all-repositories") {
      for (const [index, scope] of connector.scopes.entries()) {
        if (!definition.repositories.some((repository) => repository.name === scope)) throw invalid(`scopes.${String(index)}: is not a repository of this project`);
      }
    }
    return;
  }
  if (connector.type === "asana") throw invalid(`type: a project connector is one of ${ACCEPTED_CONNECTOR_TYPES.join(", ")}`);
  // A change that adds no reach to a connector as it was confirmed (a narrowing, or the same tools again) needs no connection: it can only hold or shrink what is there.
  if (holdsApproval) return;
  const connections = deps.projectConnectors.connections;
  if (connections === undefined) throw agentXError("NOT_FOUND", "connections are not set up in this deployment");
  // Keyed by the caller's org: another org's connection id reads exactly as one nobody has.
  const connection = await connections.get(orgId, connector.credentialRef);
  if (connection === undefined || connection.type !== connector.type) throw invalid(`credentialRef: no ${connector.type} connection called ${connector.credentialRef} in your organization`);
  // A CloudWatch connection has no key: Rovara assumes its role instead.
  if (!connection.hasSecret && connectionTakesSecret(connection.type)) throw invalid(`credentialRef: ${connection.label} has no key saved yet; add one to the connection first`);
  const write = connector.tools.findIndex((tool) => tool.access === "write");
  if (write >= 0 && connection.access !== "read_write") throw invalid(`tools.${String(write)}: ${connection.label} is read-only`);
}

// ---- what people see

type Status = "connected" | "not_connected" | "unavailable";
interface ConnectorView {
  name: string;
  type: string;
  connectionId?: string;
  scopes: unknown;
  tools: Array<{ name: string; access: string }>;
  status: Status;
  problem?: string;
}

const UNKNOWN_PROBLEM = "Rovara could not check this connector just now";
const NOT_WORKING_PROBLEM = "ask a maintainer of this project why it is not connected";
const CHANGED_PROBLEM = "this connector was changed or removed after this request";

/** A connector as the app shows it, with the status the preflight gave it (`unavailable` when no preflight entry names it). */
function viewOf(entry: StoredEntry, preflight: ConnectorPreflight | undefined, fallback: string = UNKNOWN_PROBLEM, showProblem = true): ConnectorView {
  const stored = entry as { name: string; type: string; credentialRef?: unknown; scopes?: unknown; tools?: unknown };
  const tools = Array.isArray(stored.tools) ? (stored.tools as Array<{ name: string; access: string }>).map((tool) => ({ name: tool.name, access: tool.access })) : [];
  return {
    name: stored.name,
    type: stored.type,
    ...(ConnectionIdSchema.safeParse(stored.credentialRef).success ? { connectionId: String(stored.credentialRef) } : {}),
    scopes: stored.scopes ?? [],
    tools,
    status: preflight?.status ?? "unavailable",
    // The vendor's and the registry's words are for those who can fix it; anyone else is told only that it is not working.
    ...(preflight === undefined ? { problem: fallback } : preflight.problem === undefined ? {} : { problem: showProblem ? preflight.problem : NOT_WORKING_PROBLEM }),
  };
}

const STATUS_CACHE_MS = 60_000;
const MAX_CACHED_STATUSES = 1_000;
/** One cache per set of dependencies (so per broker): a connector's status by org, project, revision and name. */
interface StatusEntry { at: number; entry: ConnectorPreflight | null }
type StatusCache = Map<string, StatusEntry>;
const statusCaches = new WeakMap<Connectors, StatusCache>();

/**
 * The statuses of a revision's connectors now, asked of the vendors at most once a minute for the same org, project, revision and connector, so a
 * page that is read often does not spend the org's vendor rate limit. A check that fails as a whole marks every connector `unavailable`, is
 * logged by name only, and is not remembered.
 */
async function liveStatuses(deps: Deps, caller: { orgId: OrgId; developerId: string }, definition: StoredProjectDefinition): Promise<ConnectorPreflight[]> {
  const cache: StatusCache = statusCaches.get(deps.projectConnectors) ?? new Map<string, StatusEntry>();
  statusCaches.set(deps.projectConnectors, cache);
  const now = deps.now();
  const keyOf = (name: string) => `${caller.orgId}|${definition.name}|${String(definition.revision)}|${name}`;
  const names = storedConnectors(definition).map((entry) => entry.name);
  const fresh = names.map((name) => cache.get(keyOf(name))).filter((found): found is NonNullable<typeof found> => found !== undefined && now - found.at < STATUS_CACHE_MS);
  if (fresh.length === names.length) return fresh.flatMap((found) => (found.entry === null ? [] : [found.entry]));
  try {
    const statuses = await deps.projectConnectors.preflight({ orgId: caller.orgId, ownerKey: caller.developerId }, definition);
    if (cache.size >= MAX_CACHED_STATUSES) for (const [key, found] of cache) if (now - found.at >= STATUS_CACHE_MS) cache.delete(key);
    for (const name of names) cache.set(keyOf(name), { at: now, entry: statuses.find((status) => status.name === name) ?? null });
    return statuses;
  } catch (error) {
    console.error(JSON.stringify({ component: "broker", level: "error", event: "project_connectors.preflight_failed", error: error instanceof Error ? error.name : "unknown" }));
    return [];
  }
}

// ---- repeated requests (R18)

/** What a request is, apart from its id: the route, the project, the connector and the rest of the body. */
function fingerprintOf(route: string, project: string, name: string, body: { requestId: string }): string {
  const { requestId: _requestId, ...rest } = body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the key, not part of what was asked
  return createHash("sha256").update(canonicalJson({ route, project, name, body: rest }), "utf8").digest("hex");
}

/**
 * The mark a change carries, and what the same request did the last time (`replay`), if it changed anything. Read after the role checks, so a
 * repeat tells nobody who lost their role anything. The same id for another request is `CONFIG_INVALID`.
 */
async function markRequest(deps: Deps, caller: AgentCaller, route: string, project: string, name: string, body: { requestId: string }): Promise<{ mark: RequestMark; replay?: { result: unknown } }> {
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId, fingerprint: fingerprintOf(route, project, name, body) };
  const earlier = await readRequest(deps, caller.orgId, caller.developerId, body.requestId);
  if (earlier === undefined) return { mark };
  if (earlier.fingerprint !== mark.fingerprint) throw invalid("requestId: this request ID was already used for a different request");
  return { mark, replay: { result: earlier.result } };
}

/** What a mark remembers of a change: the revision and the connector as written (no status, which is read live on a repeat). */
interface Remembered { revision: number; connector?: ConnectorConfig; removed?: { name: string } }

const reusedRequest = () => invalid("requestId: this request ID was already used for a different request");

/** The answer to a repeat of a change: what it wrote, with the connector's status read now. */
async function replayAnswer(deps: Deps, caller: AgentCaller, project: string, remembered: Remembered): Promise<unknown> {
  if (remembered.removed !== undefined) return { removed: remembered.removed, revision: remembered.revision };
  const connector = remembered.connector as ConnectorConfig;
  const latest = await latestRevision(deps, caller.orgId, project);
  const current = latest === undefined ? undefined : storedConnectors(latest.definition).find((entry) => entry.name === connector.name);
  const statuses = latest === undefined || current === undefined || canonicalJson(current) !== canonicalJson(connector) ? [] : await liveStatuses(deps, caller, latest.definition);
  return { revision: remembered.revision, connector: viewOf(connector, statuses.find((status) => status.name === connector.name), CHANGED_PROBLEM) };
}

// ---- writing a revision

/** How the audit event words a change. */
type ChangeKind = "added" | "updated" | "widened" | "removed";

/** An opaque, stable id for one project's connector, so the chain names it without a project's name or a connector's label. */
const connectorAuditId = (project: string, name: string): string => `cnr_${createHash("sha256").update(`${project}\n${name}`, "utf8").digest("hex").slice(0, 24)}`;

interface WriteInput {
  orgId: OrgId;
  project: string;
  /** Who writes it: the person who asked, or the one who confirmed. */
  by: string;
  name: string;
  /** The connector as it is to be, or undefined to remove the one called `name`. */
  next: ConnectorConfig | undefined;
  latest: LatestRevision;
  /** The request item of the route that made the change (R18); a confirmation has none (the approval record is its own). */
  request?: RequestMark;
  /** A confirmed widening: the approval, and how the decision was made. */
  approval?: { approvalId: string; proof?: AuditProof };
  /** The connectors whose credential registration must find: the one being saved, none for a removal or a narrowing that holds what was confirmed. */
  credentialsChecked: string[];
}

/**
 * Writes `next` (or its removal) as the project's next revision, keeping every other field, with the request item and the audit event in the same
 * transaction as the revision. A change that leaves the connectors as they are writes no revision (its request item alone). Returns what to answer.
 */
async function writeRevision(deps: Deps, input: WriteInput): Promise<{ revision: number; changed: boolean; preflight: ConnectorPreflight[] | undefined }> {
  const { latest } = input;
  const current = latest.definition;
  const { previous, connectors } = rebuildConnectors(current, input.name, input.next);
  if (input.next === undefined && previous === undefined) throw agentXError("NOT_FOUND", "no connector has that name");
  const unchanged = input.next !== undefined && previous !== undefined && canonicalJson(previous) === canonicalJson(input.next);
  const remembered: Remembered = input.next === undefined ? { revision: current.revision + 1, removed: { name: input.name } } : { revision: unchanged ? current.revision : current.revision + 1, connector: input.next };
  if (unchanged) {
    // Nothing differs from what is stored: the project stays at the revision the person saw, and the request still leaves its item.
    if (input.request !== undefined) await commit(deps, [], () => undefined, input.request, remembered);
    return { revision: current.revision, changed: false, preflight: undefined };
  }
  const revision = current.revision + 1;
  const { integrations: _integrations, ...rest } = current; // eslint-disable-line @typescript-eslint/no-unused-vars -- rebuilt below from the new connectors
  const parsed = ProjectDefinitionSchema.safeParse({ ...rest, revision, ...(connectors.length > 0 ? { integrations: { connectors } } : {}) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const kind: ChangeKind = input.next === undefined ? "removed" : previous === undefined ? "added" : widenings(previous, input.next, input.project).length > 0 ? "widened" : "updated";
  const at = new Date(deps.now()).toISOString();
  const type = (input.next ?? previous) as { type: string };
  const events = await tryAuditEvents(deps, () => [auditProjectConnectorChanged({
    orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: at, occurrence: auditOccurrence(input.project, String(revision)),
    connectorId: connectorAuditId(input.project, input.name), connectorType: type.type, revision, change: kind,
    ...(input.approval === undefined ? {} : { related: [input.approval.approvalId], ...(input.approval.proof === undefined ? {} : { proof: input.approval.proof }) }),
    details: [{ subject: "org", fields: { project: input.project, connector: input.name } }],
  })]);
  const extraItems: TransactItem[] = [
    ...events.flatMap((event) => auditPending(deps, event)),
    ...(input.request === undefined ? [] : [requestMarkItem(deps, input.request, remembered)]),
  ];
  let registered: Awaited<ReturnType<Connectors["registerRevision"]>>;
  try {
    registered = await deps.projectConnectors.registerRevision({ orgId: input.orgId, ownerKey: input.by }, { definition: parsed.data, runtimeBinding: latest.runtimeBinding, credentialsChecked: input.credentialsChecked }, extraItems);
  } catch (error) {
    // Another save took this revision number first, or the catalog moved under this one.
    if (error instanceof AgentXError && error.code === "PROJECT_REVISION_MISMATCH") throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
    throw error;
  }
  // The revision was already there, so none of this request's items was written: another request made this very change first.
  if (registered.duplicate) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  await flushAuditEvents(deps, events);
  return { revision, changed: true, preflight: registered.preflight?.connectors };
}

// ---- handlers

/** Who is listed for a widening: the maintainers of the project and the org's owners and admins (the project's members include them). The rule decides who may decide. */
async function listedApprovers(deps: Deps, orgId: OrgId, project: string): Promise<string[]> {
  const members = await deps.projectMembers.list(orgId, project);
  return [...new Set(members.filter((member) => projectAllows(member.role, "edit_settings")).map((member) => member.developerId))];
}

async function listConnectors(deps: Deps, caller: AgentCaller, project: string): Promise<unknown> {
  const role = await roleOnProject(deps, caller, project);
  if (!deps.projectConnectors.cloud) throw agentXError("FORBIDDEN", PRIVATE_INSTALL_MESSAGE);
  const latest = await latestRevision(deps, caller.orgId, project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const statuses = await liveStatuses(deps, caller, latest.definition);
  const byName = new Map(statuses.map((status) => [status.name, status]));
  return { revision: latest.definition.revision, connectors: storedConnectors(latest.definition).map((entry) => viewOf(entry, byName.get(entry.name), UNKNOWN_PROBLEM, projectAllows(role, "edit_settings"))) };
}

async function putConnector(deps: Deps, caller: AgentCaller, project: string, name: string, body: unknown): Promise<unknown> {
  await requireMayChange(deps, caller, project);
  const input = parseBody(PutBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "put", project, name, input);
  if (replay !== undefined) return replayAnswer(deps, caller, project, replay.result as Remembered);
  const connector = parseConnector(input.connector, name);
  // A request that already made a waiting change is that change again (or a different request under the same id); it is answered before the revision is looked at.
  const earlier = await pendingChangeFor(deps, caller.orgId, caller.developerId, input.requestId);
  if (earlier !== undefined) return waitingAnswer(deps, caller, earlier, { project, name, expectedRevision: input.expectedRevision, connector });
  const latest = await loadCurrent(deps, caller.orgId, project, input.expectedRevision);
  const { previous } = rebuildConnectors(latest.definition, name, connector);
  const widened = widenings(previous, connector, project);
  // The same target with nothing newly able to write holds or shrinks what was confirmed; it needs no connection to be there.
  const holdsApproval = previous !== undefined && widened.length === 0 && targetMoved(previous, connector) === undefined;
  await validateConnector(deps, caller.orgId, latest.definition, connector, holdsApproval);
  if (widened.length > 0) {
    const subject: ConnectorWidenSubject = { kind: "connector_widen", project, name, expectedRevision: input.expectedRevision, connector };
    const record = await createPendingChange(deps, {
      orgId: caller.orgId, requestId: input.requestId, requestedBy: caller.developerId, subject, changes: widened,
      approvers: { kind: "rule", rule: "project_settings", candidates: await listedApprovers(deps, caller.orgId, project) },
    });
    return waitingAnswer(deps, caller, record, subject);
  }
  const written = await writeRevision(deps, { orgId: caller.orgId, project, by: caller.developerId, name, next: connector, latest, request: mark, credentialsChecked: holdsApproval ? [] : [name] });
  // A change that wrote nothing leaves the stored revision as it is, which is what the status is read from.
  const statuses = written.preflight ?? await liveStatuses(deps, caller, latest.definition);
  return { revision: written.revision, connector: viewOf(connector, statuses.find((status) => status.name === name)) };
}

async function deleteConnector(deps: Deps, caller: AgentCaller, project: string, name: string, body: unknown): Promise<unknown> {
  await requireMayChange(deps, caller, project);
  const input = parseBody(DeleteBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "delete", project, name, input);
  if (replay !== undefined) return replayAnswer(deps, caller, project, replay.result as Remembered);
  // A request id that made a waiting widening is that request's, not a removal's.
  if (await pendingChangeFor(deps, caller.orgId, caller.developerId, input.requestId) !== undefined) throw reusedRequest();
  const latest = await loadCurrent(deps, caller.orgId, project, input.expectedRevision);
  const written = await writeRevision(deps, { orgId: caller.orgId, project, by: caller.developerId, name, next: undefined, latest, request: mark, credentialsChecked: [] });
  return { removed: { name }, revision: written.revision };
}

/**
 * The answer for a change that waits on the page: the same record again for a repeat of the request that made it. Once it was decided, a repeat is
 * told what came of it: the connector and the revision as they are now when it was applied, otherwise how it ended.
 */
async function waitingAnswer(deps: Deps, caller: AgentCaller, record: ApprovalRecord, wanted: Omit<ConnectorWidenSubject, "kind">): Promise<unknown> {
  const subject = record.subject;
  if (subject.kind !== "connector_widen" || subject.project !== wanted.project || subject.name !== wanted.name || subject.expectedRevision !== wanted.expectedRevision
    || canonicalJson(subject.connector) !== canonicalJson(wanted.connector)) throw reusedRequest();
  switch (record.status) {
    case "PENDING":
      return new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: confirmUrlFor(deps, record), changes: record.changes });
    case "EXECUTING":
      return new StatusReply(202, { status: "EXECUTING" });
    case "APPROVED_DONE": {
      const latest = await latestRevision(deps, caller.orgId, subject.project);
      return replayAnswer(deps, caller, subject.project, { revision: latest?.definition.revision ?? subject.expectedRevision + 1, connector: subject.connector });
    }
    default:
      return { status: record.status, ...(record.failure === undefined ? {} : { failure: record.failure }) };
  }
}

// ---- routing

const PATH = /^\/v1\/app\/projects\/([^/]+)\/connectors(?:\/([^/]+)(\/.*)?)?$/;

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw invalid("the request body is not JSON");
  }
}

/**
 * The project connector routes. A path under `…/connectors/{name}/…` is not a connector's: `…/connectors/github/comment-triggers` is Task 14b's,
 * which its route answers before this one is called (PF24); until that route is merged it is not found here, however the caller is placed.
 */
export async function routeProjectConnectorRequest(deps: ApprovalDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const connectorDeps = requireConnectorDeps(deps);
  const matched = PATH.exec(url.pathname);
  if (matched === null) throw agentXError("NOT_FOUND", "route not found");
  const [, rawProject, rawName, rest] = matched;
  if (rest !== undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
  let project: string;
  try { project = decodeURIComponent(rawProject!); } catch { throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name"); }
  if (rawName === undefined) {
    if (request.method === "GET") return listConnectors(connectorDeps, caller, project);
    throw agentXError("NOT_FOUND", "route not found");
  }
  const name = ConnectorNameSchema.safeParse(rawName);
  if (!name.success) throw agentXError("NOT_FOUND", "no connector has that name");
  if (request.method === "PUT") return putConnector(connectorDeps, caller, project, name.data, jsonBody(request));
  if (request.method === "DELETE") return deleteConnector(connectorDeps, caller, project, name.data, jsonBody(request));
  throw agentXError("NOT_FOUND", "route not found");
}

// ---- what confirming does

/**
 * Whether `caller` may confirm a connector widening now (R68, PF5): a maintainer of the project (`edit_settings`), which an org owner or admin is of
 * every project of the org; read now, never from the session. A person removed from the org, or demoted since the request was made, may not.
 */
async function mayConfirmWidening(deps: ApprovalDependencies, record: ApprovalRecord, caller: AgentCaller): Promise<boolean> {
  if (caller.orgId !== record.orgId || record.subject.kind !== "connector_widen") return false;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(record.orgId, record.subject.project, { developerId: await resolveSurvivor(deps, record.orgId, caller.developerId), orgRole });
  return role !== undefined && projectAllows(role, "edit_settings");
}

/**
 * Applies a confirmed widening: exactly the stored connector, while the project is still at the revision that was shown. Applying it again (the
 * decision stopped before it was recorded, and is re-driven) finds the project past that revision with the connector as approved, and is done.
 */
async function confirmWidening(deps: ApprovalDependencies, record: ApprovalRecord, decision?: { proof?: AuditProof }): Promise<void> {
  // Nobody having decided it means the events would credit the person who asked.
  if (record.decidedBy === undefined) throw invalid("this change has not been decided by anyone, so it can't be applied");
  const subject = record.subject as ConnectorWidenSubject;
  // The record was made by the route, which checked these; they are checked again because what is written is read from it.
  if (!AgentXNameSchema.safeParse(subject.project).success || subject.connector.name !== subject.name) throw invalid("this change is not one that can be applied");
  const connectorDeps = requireConnectorDeps(deps);
  if (!connectorDeps.projectConnectors.cloud) throw agentXError("FORBIDDEN", PRIVATE_INSTALL_MESSAGE);
  let latest: LatestRevision;
  try {
    latest = await loadCurrent(connectorDeps, record.orgId, subject.project, subject.expectedRevision);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "PROJECT_REVISION_MISMATCH" && await alreadyApplied(connectorDeps, record.orgId, subject)) return;
    throw error;
  }
  // The connection may have been removed, or lowered to read-only, since this was asked.
  await validateConnector(connectorDeps, record.orgId, latest.definition, subject.connector);
  await writeRevision(connectorDeps, {
    orgId: record.orgId, project: subject.project, by: record.decidedBy, name: subject.name, next: subject.connector, latest, credentialsChecked: [subject.name],
    approval: { approvalId: record.approvalId, ...(decision?.proof === undefined ? {} : { proof: decision.proof }) },
  });
}

/** Whether the project is past the revision that was shown and holds the connector as it was approved: the change is there, whoever wrote it. */
async function alreadyApplied(deps: Deps, orgId: OrgId, subject: ConnectorWidenSubject): Promise<boolean> {
  const latest = await latestRevision(deps, orgId, subject.project);
  if (latest === undefined || latest.definition.revision <= subject.expectedRevision) return false;
  const stored = storedConnectors(latest.definition).find((entry) => entry.name === subject.name);
  return stored !== undefined && canonicalJson(stored) === canonicalJson(subject.connector);
}

/** Registers the `project_settings` rule and the `connector_widen` handler. Safe to call more than once. */
export function registerProjectConnectorApprovals(): void {
  registerApproverRule("project_settings", mayConfirmWidening);
  registerApprovalSubjectHandler("connector_widen", confirmWidening);
}
