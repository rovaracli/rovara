// Meta repo lane A, task A2: the meta repo's config file, imported as a PENDING CHANGE that a maintainer applies.
//
//   push to the meta repo's default branch ─► queueMetaConfigImport ─► reads the file at that commit, validates and plans it against the project's latest revision
//   ─► a pending record (one per project; the newest push wins) ─► GET shows it (with a diff) ─► a maintainer applies it (or dismisses it)
//   ─► apply registers a new project revision, through the same registration every settings save goes through, and deletes the pending record in the same transaction.
//
// Limits come only from Rovara's settings, so the file is never applied by the push itself, and a value a person typed is never replaced unless that person names it.
// The settings a file manages are marked `origin: "file"` in the revision (`origins`), and the settings save refuses to change them (project-settings.ts).
// Everything here is control-plane only: a worker never sees any of it.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentXError,
  AgentXNameSchema,
  META_CONFIG_MAX_BYTES,
  MetaProjectConfigSchema,
  ProjectDefinitionSchema,
  agentXError,
  agentxRepositoryName,
  canonicalJson,
  codeRepositoriesOf,
  fileManagedFields,
  metaRepositoryOf,
  projectAllows,
  projectArchivedMessage,
  projectPk,
  withSettingOrigins,
  type MetaConfigProblem,
  type MetaProjectConfig,
  type OrgId,
  type OrgKey,
  type OrgRole,
  type ProjectOriginField,
  type ProjectRole,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import type { TransactItem } from "../audit/outbox.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { cloudRepositoryEntry } from "../org/cloud-projects.js";
import { readRequestRecord, requestRecordPut, requireSameRequest } from "../org/request-records.js";
import { latestRevision, SETTINGS_STALE_MESSAGE, type ProjectSettingsDependencies } from "../org/project-settings.js";
import { META_CONFIG_FILE_PATHS, desiredCommands, configRepositoryPath, githubFullName, parseMetaConfigFile, planMetaConfigChange, type ConfigField, type MetaConfigPlan, type PlanItem } from "./config-plan.js";

type Send = { send(command: unknown): Promise<unknown> };

const PENDING_SORT_KEY = "META_CONFIG_PENDING";
const REQUEST_SORT_PREFIX = "META_CONFIG_REQUEST#";
/** The stored config (canonical JSON) must fit well inside DynamoDB's 400 KB item limit. */
const STORED_CONFIG_MAX_CHARS = 300_000;

export function metaConfigPendingKey(orgId: OrgId, project: string): OrgKey {
  return { pk: projectPk(orgId, project), sk: PENDING_SORT_KEY };
}

export type PendingStatus =
  /** A change to apply. */
  | "pending"
  /** The file cannot be used; `problems` says where. Nothing is applied until it is fixed in the meta repo. */
  | "invalid"
  /** The file is gone from the meta repo but the project still has settings it managed: applying releases them to people. */
  | "released";

/** What is stored: the file's validated content (as canonical JSON) and where it came from. No file text beyond what the config holds. */
interface PendingRecord {
  entityType: "META_CONFIG_PENDING";
  status: PendingStatus;
  commit: string;
  path?: string;
  digest?: string;
  configJson?: string;
  problems?: MetaConfigProblem[];
  baseRevision: number;
  plannedAt: string;
}

export interface MetaConfigReadDependencies {
  documentClient: Send;
  tableName: string;
  now: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const log = (deps: Pick<MetaConfigReadDependencies, "log">) => deps.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface QueueDependencies extends MetaConfigReadDependencies {
  /**
   * The text of `path` in the meta repository at `commit`, or undefined when the file is not there. It throws when it cannot tell (the code host is down): the push is then
   * retried, and nothing is recorded, so an outage is never read as "the file was removed". A file over `META_CONFIG_MAX_BYTES` is a CONFIG_INVALID refusal (the reader is given
   * that cap, so the read stops there), which is recorded once as an invalid change instead of being retried for ever.
   */
  readMetaFile(input: { orgId: OrgId; project: string; repository: { name: string; url: string }; commit: string; path: string }): Promise<string | undefined>;
  /** The commit the meta repository's default branch points at NOW, as GitHub says. The order of changes is the branch's own: a push event only says "look". */
  getHead(input: { orgId: OrgId; project: string; repository: { name: string; url: string; defaultBranch: string } }): Promise<string>;
}

export type QueueOutcome = "queued" | "invalid" | "released" | "no_change" | "ignored" | "stale";

const FILE_TOO_LARGE: MetaConfigProblem = { path: "(file)", message: `the file is larger than ${String(META_CONFIG_MAX_BYTES)} bytes` };

/**
 * A push to the meta repo's default branch, or a maintainer's "check now": read the branch head from GitHub, read the config file at THAT commit, and record what it would
 * change. The commit in the event is only a hint (and the author-set commit time is not read at all), so a late or repeated delivery of an old push reads the same current head
 * and changes nothing; an old config cannot come back. If the head moves while the file is read, this run steps aside ("stale") because the newer head has its own run.
 * A project with no meta repository, or a file that matches the project already, records nothing (and clears an older pending change the new file makes pointless).
 */
export async function queueMetaConfigImport(deps: QueueDependencies, input: { orgId: OrgId; project: string; commit?: string }): Promise<QueueOutcome> {
  const latest = await latestRevision(deps, input.orgId, input.project);
  if (latest === undefined) return "ignored";
  const meta = metaRepositoryOf(latest.definition);
  if (meta === undefined) return "ignored";
  const key = metaConfigPendingKey(input.orgId, input.project);
  const repository = { name: meta.name, url: meta.url };
  const head = await deps.getHead({ orgId: input.orgId, project: input.project, repository: { ...repository, defaultBranch: meta.defaultBranch } });
  if (!/^[a-f0-9]{40}$/.test(head)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid commit");
  const base = { entityType: "META_CONFIG_PENDING" as const, commit: head, baseRevision: latest.definition.revision, plannedAt: new Date(deps.now()).toISOString() };

  let found: { path: string; text: string } | undefined;
  let tooLarge: string | undefined;
  for (const path of META_CONFIG_FILE_PATHS) {
    try {
      const text = await deps.readMetaFile({ orgId: input.orgId, project: input.project, repository, commit: head, path });
      if (text !== undefined) { found = { path, text }; break; }
    } catch (error) {
      if ((error as { code?: unknown }).code !== "CONFIG_INVALID") throw error;
      tooLarge = path;
      break;
    }
  }
  // The head moved while the file was read: a newer run owns the answer.
  if (await deps.getHead({ orgId: input.orgId, project: input.project, repository: { ...repository, defaultBranch: meta.defaultBranch } }) !== head) return "stale";

  const write = async (record: PendingRecord | undefined): Promise<void> => {
    if (record === undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
    else await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...key, ...record } }));
  };

  if (tooLarge !== undefined) {
    log(deps)("meta_config.invalid", { orgId: input.orgId, project: input.project, problems: 1 });
    await write({ ...base, status: "invalid", path: tooLarge, problems: [FILE_TOO_LARGE] });
    return "invalid";
  }
  if (found === undefined) {
    // No file. Settings it managed are released only by a person's say; a project with none of those needs nothing.
    if (fileManagedFields(latest.definition).length === 0) { await write(undefined); return "no_change"; }
    await write({ ...base, status: "released" });
    return "released";
  }
  const parsed = parseMetaConfigFile(found.path, found.text);
  if (!parsed.ok) {
    log(deps)("meta_config.invalid", { orgId: input.orgId, project: input.project, problems: parsed.problems.length });
    await write({ ...base, status: "invalid", path: found.path, problems: parsed.problems });
    return "invalid";
  }
  const configJson = canonicalJson(parsed.config);
  if (configJson.length > STORED_CONFIG_MAX_CHARS) {
    await write({ ...base, status: "invalid", path: found.path, problems: [{ path: "(file)", message: "the config is too large to store" }] });
    return "invalid";
  }
  const plan = planMetaConfigChange({ config: parsed.config, definition: latest.definition });
  if (plan.items.length === 0 && plan.problems.length === 0) { await write(undefined); return "no_change"; }
  const record: PendingRecord = plan.problems.length > 0
    ? { ...base, status: "invalid", path: found.path, digest: sha256(configJson), problems: plan.problems }
    : { ...base, status: "pending", path: found.path, digest: sha256(configJson), configJson };
  await write(record);
  return record.status === "invalid" ? "invalid" : "queued";
}

// ---- reading

export interface MetaConfigCaller { developerId: string; orgId: OrgId; orgRole: OrgRole }

export interface MetaConfigDependencies<Caller extends MetaConfigCaller = MetaConfigCaller> extends QueueDependencies {
  cloud: boolean;
  effectiveRole(caller: Caller, project: string): Promise<ProjectRole | undefined>;
  registerRevision: ProjectSettingsDependencies<Caller>["registerRevision"];
  githubCredentialRef?: string;
  repositoryIdentity?: ProjectSettingsDependencies<Caller>["repositoryIdentity"];
  requireRepositoryConnected?: ProjectSettingsDependencies<Caller>["requireRepositoryConnected"];
}

export interface MetaConfigView {
  /** The settings the config file manages: read-only in the app, changed by changing the file. */
  managedFields: ProjectOriginField[];
  pending?: {
    status: PendingStatus;
    commit: string;
    path?: string;
    plannedAt: string;
    /** The project revision the change was planned against; apply needs the revision the person is looking at. */
    baseRevision: number;
    problems: MetaConfigProblem[];
    items: PlanItem[];
    deferred: string[];
  };
}

async function readPending(deps: MetaConfigReadDependencies, orgId: OrgId, project: string): Promise<PendingRecord | undefined> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: metaConfigPendingKey(orgId, project), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined || item.entityType !== "META_CONFIG_PENDING") return undefined;
  const status = item.status;
  if (status !== "pending" && status !== "invalid" && status !== "released") return undefined;
  if (typeof item.commit !== "string" || typeof item.baseRevision !== "number" || typeof item.plannedAt !== "string") return undefined;
  return item as unknown as PendingRecord;
}

function storedConfig(record: PendingRecord): MetaProjectConfig | undefined {
  if (record.configJson === undefined) return undefined;
  try {
    const parsed = MetaProjectConfigSchema.safeParse(JSON.parse(record.configJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function requireRole<Caller extends MetaConfigCaller>(deps: Pick<MetaConfigDependencies<Caller>, "effectiveRole">, caller: Caller, project: string, needs: "view" | "edit"): Promise<void> {
  const role = await deps.effectiveRole(caller, project);
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if (needs === "edit" && !projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change its settings");
}

/**
 * What the app shows: the settings the file manages, and the pending change with its diff, planned against the project as it is now (so the diff is never stale
 * against the project, only against the file). Any member who can see the project may read it.
 */
export async function readMetaConfigState<Caller extends MetaConfigCaller>(deps: MetaConfigDependencies<Caller>, caller: Caller, project: string): Promise<MetaConfigView> {
  await requireRole(deps, caller, project, "view");
  const latest = await latestRevision(deps, caller.orgId, project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const managedFields = fileManagedFields(latest.definition);
  const record = await readPending(deps, caller.orgId, project);
  if (record === undefined) return { managedFields };
  let plan: MetaConfigPlan = { items: [], deferred: [], problems: record.problems ?? [] };
  if (record.status === "pending") {
    const config = storedConfig(record);
    plan = config === undefined
      ? { items: [], deferred: [], problems: [{ path: "(file)", message: "the stored config could not be read; wait for the next push or dismiss this change" }] }
      : planMetaConfigChange({ config, definition: latest.definition });
  }
  return {
    managedFields,
    pending: {
      status: record.status, commit: record.commit, ...(record.path === undefined ? {} : { path: record.path }), plannedAt: record.plannedAt,
      baseRevision: latest.definition.revision, problems: plan.problems, items: plan.items, deferred: plan.deferred,
    },
  };
}

// ---- applying

export const ApplyMetaConfigBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  /** The commit of the file the person looked at; a newer push replaces the pending change, and this must then be asked again. */
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  /** Fields whose value a person typed, which the person agrees to replace with the file's. */
  useFile: z.array(z.enum(["repositories", "setup", "readiness", "specTarget"])).max(4).optional(),
  /** Repositories the file no longer lists, which the person confirms should leave the project. */
  confirmRemovals: z.array(AgentXNameSchema).max(32).optional(),
}).strict();
export type ApplyMetaConfigBody = z.infer<typeof ApplyMetaConfigBodySchema>;

export const DismissMetaConfigBodySchema = z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict();

export interface ApplyMetaConfigResult {
  applied: string[];
  notApplied: Array<{ id: string; reason: "blocked" | "person_value" | "unconfirmed_removal" }>;
  revision: number;
  duplicate: boolean;
}

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const parseBody = <Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
};

const CONFIG_STALE_MESSAGE = "the meta repo's config changed since you looked; reload and try again";

/**
 * A maintainer applies the pending change. The order is the settings save's: no access is a 404, a role that may not edit settings a 403, a non-cloud install a 403;
 * then the revision and the file's commit the person saw, every refusal that needs no write, and the write last, as one transaction (the new revision, the pending
 * record's deletion and the request's record), so a refusal leaves the project as it was and a repeat of the request answers the same result.
 *
 * Applied: the items with nothing in the way. Not applied, and said so: an item that is blocked, one that would replace a value a person typed (unless the person
 * named the field in `useFile`) and a removal the person did not confirm. A change with a problem in it (a command that cannot be read, a name the project does not
 * have) is refused whole, because the file is the source of truth and half of it applied is not what it says.
 */
export async function applyMetaConfigChange<Caller extends MetaConfigCaller>(deps: MetaConfigDependencies<Caller>, caller: Caller, project: string, rawBody: unknown): Promise<ApplyMetaConfigResult> {
  await requireRole(deps, caller, project, "edit");
  if (!deps.cloud) throw agentXError("FORBIDDEN", "ask an administrator to change this project with agentx admin project register");
  if ((await readProjectMeta(deps, caller.orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  const body = parseBody(ApplyMetaConfigBodySchema, rawBody);
  const nowMs = deps.now();
  const requestKey: OrgKey = { pk: projectPk(caller.orgId, project), sk: `${REQUEST_SORT_PREFIX}${body.requestId}` };
  const bodyHash = sha256(canonicalJson({ ...body, useFile: [...(body.useFile ?? [])].sort(), confirmRemovals: [...(body.confirmRemovals ?? [])].sort() }));
  const earlier = await readRequestRecord(deps.documentClient, deps.tableName, requestKey, nowMs);
  if (earlier !== undefined) {
    requireSameRequest(earlier, { by: caller.developerId, action: "apply_meta_config", bodyHash }, "this requestId was already used for a different change");
    const result = earlier.result as Omit<ApplyMetaConfigResult, "duplicate"> | undefined;
    if (result === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "this requestId was already used for a different change");
    return { ...result, duplicate: true };
  }

  const record = await readPending(deps, caller.orgId, project);
  if (record === undefined || record.commit !== body.commit) throw agentXError("PROJECT_REVISION_MISMATCH", CONFIG_STALE_MESSAGE);
  // The pending change is applied only while it is still the branch's head: GitHub is asked now, so a config the branch has since moved past (or been rolled back from) is not applied.
  const metaRepository = metaRepositoryOf((await latestRevision(deps, caller.orgId, project))?.definition ?? { repositories: [] });
  if (metaRepository === undefined || await deps.getHead({ orgId: caller.orgId, project, repository: { name: metaRepository.name, url: metaRepository.url, defaultBranch: metaRepository.defaultBranch } }) !== record.commit) {
    throw agentXError("PROJECT_REVISION_MISMATCH", CONFIG_STALE_MESSAGE);
  }
  if (record.status === "invalid") throw invalid("the meta repo's config has problems; fix it in the meta repo");
  const latest = await latestRevision(deps, caller.orgId, project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const current = latest.definition;
  if (current.revision !== body.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  if (current.e2e !== undefined || latest.setupApproval !== undefined) {
    throw agentXError("FORBIDDEN", "this project carries an end-to-end policy or a setup approval that only an administrator can change; ask an administrator to change it with agentx admin project register");
  }

  const pendingGone = (): TransactItem => ({ Delete: { TableName: deps.tableName, Key: metaConfigPendingKey(caller.orgId, project), ConditionExpression: "#commit = :commit", ExpressionAttributeNames: { "#commit": "commit" }, ExpressionAttributeValues: { ":commit": record.commit } } });
  let next: Record<string, unknown>;
  let applied: string[];
  const notApplied: ApplyMetaConfigResult["notApplied"] = [];

  if (record.status === "released") {
    // The file is gone: the settings it managed are the people's again. Their values stay as they are.
    const managed = fileManagedFields(current);
    next = { ...current, revision: current.revision + 1 };
    const origins = withSettingOrigins(current.origins, managed, "person");
    if (origins === undefined) delete next.origins; else next.origins = origins;
    applied = managed.map((field) => `release:${field}`);
  } else {
    const config = storedConfig(record);
    if (config === undefined) throw invalid("the stored config could not be read; wait for the next push or dismiss this change");
    const plan = planMetaConfigChange({ config, definition: current });
    if (plan.problems.length > 0) throw invalid("the meta repo's config has problems; fix it in the meta repo");
    const useFile = new Set<ConfigField>(body.useFile ?? []);
    const confirmed = new Set(body.confirmRemovals ?? []);
    const chosen: PlanItem[] = [];
    for (const item of plan.items) {
      if (item.blocked !== undefined) notApplied.push({ id: item.id, reason: "blocked" });
      else if (item.conflict !== undefined && !useFile.has(item.field)) notApplied.push({ id: item.id, reason: "person_value" });
      else if (item.needsConfirmation === true && !confirmed.has(item.repository ?? "")) notApplied.push({ id: item.id, reason: "unconfirmed_removal" });
      else chosen.push(item);
    }
    for (const name of confirmed) {
      if (!plan.items.some((item) => item.kind === "remove_repository" && item.repository === name)) throw invalid(`confirmRemovals: ${name} is not a repository the file removes`);
    }
    if (chosen.length === 0) return { applied: [], notApplied, revision: current.revision, duplicate: false };

    const removed = new Set(chosen.filter((item) => item.kind === "remove_repository").map((item) => item.repository!));
    const addedEntries = await resolveAddedRepositories(deps, caller, config, chosen.filter((item) => item.kind === "add_repository"));
    // The meta repository stays last, so "commands run in the first repository" still means a code repository.
    const kept = current.repositories.filter((repository) => !removed.has(repository.name));
    const repositories = [...kept.filter((repository) => repository.role !== "meta"), ...addedEntries, ...kept.filter((repository) => repository.role === "meta")];
    next = { ...current, revision: current.revision + 1, repositories };
    const codeAfter = codeRepositoriesOf({ repositories }).map((repository) => ({ name: repository.name, path: repository.path }));

    const changedFields: ProjectOriginField[] = [];
    if (chosen.some((item) => item.field === "repositories")) changedFields.push("repositories");
    for (const [section, field, key] of [["setup", "setup", "setup"], ["tests", "readiness", "readiness"]] as const) {
      if (chosen.some((item) => item.field === field)) {
        const desired = desiredCommands(section, config, codeAfter);
        if (desired.problems.length > 0) throw invalid("the meta repo's config has problems; fix it in the meta repo");
        next[key] = desired.commands;
        changedFields.push(field);
      }
    }
    // Meta repo lane D: the spec target the file names (validated when the file was read; the project definition is parsed again below).
    if (chosen.some((item) => item.field === "specTarget") && config.specTarget !== undefined) {
      next.specTarget = config.specTarget;
      changedFields.push("specTarget");
    }
    // A repository that leaves must not leave a command or the devcontainer behind: those would run in a folder that is gone.
    const devcontainer = current.devcontainer;
    for (const name of removed) {
      const path = current.repositories.find((repository) => repository.name === name)!.path;
      if (devcontainer?.repository === name) throw invalid(`confirmRemovals: ${name} is the devcontainer's repository; change the devcontainer first`);
      const kept = [...(next.setup as Array<{ cwd: string }>), ...(next.readiness as Array<{ cwd: string }>)];
      if (kept.some((command) => command.cwd === path || command.cwd.startsWith(`${path}/`))) throw invalid(`confirmRemovals: commands run in ${name}; the file's setup and tests must not use it`);
    }
    const origins = withSettingOrigins(current.origins, changedFields, "file");
    if (origins === undefined) delete next.origins; else next.origins = origins;
    applied = chosen.map((item) => item.id);
  }

  const parsed = ProjectDefinitionSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const result: Omit<ApplyMetaConfigResult, "duplicate"> = { applied, notApplied, revision: parsed.data.revision };
  const extra: TransactItem[] = [
    pendingGone(),
    requestRecordPut(deps.tableName, requestKey, "META_CONFIG_REQUEST", { by: caller.developerId, action: "apply_meta_config", bodyHash, result }, nowMs),
  ];
  try {
    await deps.registerRevision({ orgId: caller.orgId, ownerKey: caller.developerId }, { definition: parsed.data, runtimeBinding: latest.runtimeBinding }, extra);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "PROJECT_REVISION_MISMATCH") throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
    throw error;
  }
  log(deps)("meta_config.applied", { orgId: caller.orgId, project, revision: parsed.data.revision, items: applied.length, notApplied: notApplied.length });
  return { ...result, duplicate: false };
}

/** The repositories a change adds, each reached through the org's own GitHub connection and described by GitHub, as the settings save does it. */
async function resolveAddedRepositories<Caller extends MetaConfigCaller>(
  deps: MetaConfigDependencies<Caller>, caller: Caller, config: MetaProjectConfig, items: PlanItem[],
): Promise<StoredProjectDefinition["repositories"]> {
  if (items.length === 0) return [];
  const credential = deps.githubCredentialRef;
  if (deps.repositoryIdentity === undefined || credential === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "adding a repository is not set up in this deployment; ask Rovara support");
  const connected = deps.requireRepositoryConnected;
  if (connected === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "adding a repository is not set up in this deployment; ask Rovara support");
  const entries: StoredProjectDefinition["repositories"] = [];
  for (const item of items) {
    const wanted = (config.repositories ?? []).find((entry) => entry.name === item.repository)!;
    const full = githubFullName(wanted.url)!;
    const [owner, name] = full.split("/") as [string, string];
    const answer = await connected(caller.orgId, owner, name);
    const identity = await deps.repositoryIdentity(`https://github.com/${full}.git`, caller.orgId);
    if (identity === undefined) throw invalid(`repositories.${wanted.name}: the GitHub App cannot see ${full}; check the address`);
    // The file is repository-supplied text: GitHub's description must be of the repository the connection was checked for, under the owner the file named.
    if (answer.githubRepositoryId !== undefined && identity.repositoryId !== answer.githubRepositoryId) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub described ${full} differently a moment ago; try again`);
    if (identity.fullName.split("/")[0]?.toLowerCase() !== owner.toLowerCase()) throw agentXError("FORBIDDEN", `GitHub describes ${full} under another owner; use its current owner/name`);
    if (identity.defaultBranch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not describe that repository; try again");
    const entry = cloudRepositoryEntry({
      repositoryName: name, repository: { fullName: identity.fullName, defaultBranch: identity.defaultBranch }, githubCredentialRef: credential,
      ...(answer.githubRepositoryId === undefined ? {} : { connection: { installationId: answer.installationId, githubRepositoryId: answer.githubRepositoryId } }),
    });
    // The file names the repository in the project (`name`, `path`); GitHub's own spelling decides the rest.
    if (agentxRepositoryName(wanted.name) !== wanted.name) throw invalid(`repositories.${wanted.name}: is not a name a repository of a project may have`);
    entries.push({ ...entry, name: wanted.name, path: configRepositoryPath(wanted), role: "code" });
  }
  return entries;
}

/** A maintainer sets the pending change aside. The next push to the meta repo can bring it back. */
export async function dismissMetaConfigChange<Caller extends MetaConfigCaller>(deps: MetaConfigDependencies<Caller>, caller: Caller, project: string, rawBody: unknown): Promise<{ dismissed: boolean }> {
  await requireRole(deps, caller, project, "edit");
  const body = parseBody(DismissMetaConfigBodySchema, rawBody);
  try {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: metaConfigPendingKey(caller.orgId, project), ConditionExpression: "#commit = :commit", ExpressionAttributeNames: { "#commit": "commit" }, ExpressionAttributeValues: { ":commit": body.commit } }));
    return { dismissed: true };
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw agentXError("PROJECT_REVISION_MISMATCH", CONFIG_STALE_MESSAGE);
    throw error;
  }
}

/**
 * "Check the meta repo now": a maintainer asks Rovara to read the branch head again, instead of waiting for a push. It recovers a push that was missed (GitHub does not
 * redeliver on its own) and a config that was fixed after being invalid. Same work as a push, so it records, replaces or clears the pending change the same way.
 */
export async function checkMetaConfigNow<Caller extends MetaConfigCaller>(deps: MetaConfigDependencies<Caller>, caller: Caller, project: string): Promise<{ outcome: QueueOutcome; state: MetaConfigView }> {
  await requireRole(deps, caller, project, "edit");
  const outcome = await queueMetaConfigImport(deps, { orgId: caller.orgId, project });
  return { outcome, state: await readMetaConfigState(deps, caller, project) };
}

/**
 * The routes, for the developer routes to dispatch to with one line each (wiring pending: `developer-routes.ts` is a hot file):
 *   GET  /v1/app/projects/{name}/meta-config           -> readMetaConfigState
 *   POST /v1/app/projects/{name}/meta-config/apply     -> applyMetaConfigChange
 *   POST /v1/app/projects/{name}/meta-config/dismiss   -> dismissMetaConfigChange
 *   POST /v1/app/projects/{name}/meta-config/check     -> checkMetaConfigNow (body: {})
 */
export async function routeMetaConfig<Caller extends MetaConfigCaller>(
  deps: MetaConfigDependencies<Caller>, caller: Caller, project: string, request: { method: string; action: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  if (request.action === undefined && request.method === "GET") return { status: 200, body: await readMetaConfigState(deps, caller, project) };
  if (request.method === "POST" && request.action === "apply") return { status: 200, body: await applyMetaConfigChange(deps, caller, project, request.body) };
  if (request.method === "POST" && request.action === "dismiss") return { status: 200, body: await dismissMetaConfigChange(deps, caller, project, request.body) };
  if (request.method === "POST" && request.action === "check") return { status: 200, body: await checkMetaConfigNow(deps, caller, project) };
  throw agentXError("NOT_FOUND", "route not found");
}
