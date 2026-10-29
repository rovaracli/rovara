// Company AI sources (Plan 3 Task 24b): the admin routes.
//   GET    /v1/app/org/model-sources              [any member] the sources, whether each holds a key, an endpoint's host status, a Bedrock source's note and the trust policy to paste
//   POST   /v1/app/org/model-sources              [owner or admin] { requestId, source, apiKey? } -> 201 { sourceId }
//   PUT    /v1/app/org/model-sources/{id}         [owner or admin] { requestId, source, apiKey? }
//   DELETE /v1/app/org/model-sources/{id}         [owner or admin] { requestId }
//   PUT    /v1/app/org/model-sources-order        [owner or admin] { requestId, order }
//   POST   /v1/app/org/model-sources/{id}/check  [owner or admin] -> { ok, message? }
// A key is write-only: it goes to the model proxy's credential store and is never kept, returned, logged or put in an event. Every key of the record
// is built from the caller's checked org, so another org's source answers the 404 a missing one does. The role is the caller's live membership (R68).
//
// Partial failure. A change touches the record, the proxy and (for an endpoint) the egress item, and no transaction spans them, so each order is chosen
// so that what a failure leaves behind is harmless or repaired by the same request again:
//   add / change   the proxy first (it is idempotent, and the source's id is derived from the request, so a retry registers the same models), then the
//                  record in one transaction, then the egress request. A refused record write undoes the registration; one whose outcome is not
//                  known does not (the retry converges); an egress request that did not happen shows as `not_requested` and a check makes it.
//   remove         the record first (a source no longer in it is never routed to), then the egress release and the proxy removal. A repeat of the same
//                  request finishes whatever of those did not happen.
import { createHash } from "node:crypto";
import { z } from "zod";
import { catalogModel } from "@agentx/model-runtime/catalog";
import {
  AgentXError,
  BEDROCK_NOT_TESTED_NOTE,
  EGRESS_SYNC_KEY,
  EgressSyncMarkerSchema,
  MODEL_SOURCES_NEED_PROXY,
  MODEL_SOURCE_STILL_APPLYING,
  ModelSourceIdSchema,
  ModelSourceKindSchema,
  agentXError,
  bedrockExternalId,
  bedrockTrustPolicy,
  canonicalJson,
  customSourceLimitProblem,
  egressPendingWarning,
  egressRejectedWarning,
  isAllowedDomain,
  modelSourceInputSchema,
  sourceKindProblem,
  type EgressDomainsItem,
  type ModelIdentifier,
  type ModelSource,
  type ModelSourceInput,
  type OrgId,
  type SourceLaunch,
} from "@agentx/contracts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { AgentCaller } from "../agents/access.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import type { RequestMark } from "../agents/table-writes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import type { ModelAccess } from "../model-proxy/access.js";
import { putEgressDomains, readEgressDomains, type EgressDomainsDependencies } from "../org/egress-domains.js";
import { ReviewedSourceOrderBodySchema } from "./reviewed-order.js";
import { finishRemovals, releaseSource, viaProxy } from "./release.js";
import type { ModelSourceStore, StoredModelSources } from "./store.js";

/** What the routes need beyond the agent routes' own dependencies. Absent on an install with no model proxy: every route then says so. */
export interface ModelSourceRouteDependencies {
  store: ModelSourceStore;
  /** The model proxy: where a source's models and key are registered, and what tests a source. */
  access: Pick<ModelAccess, "upsertSource" | "removeSource" | "checkSource">;
  /** Egress items and the firewall sync, for an endpoint's host. */
  egress: EgressDomainsDependencies;
  /** Which kinds and transports are on. Default: the shipped launch lists (nothing yet). */
  launch?: SourceLaunch;
  /**
   * Task 12b's `checkEndpointUrl`, bound to a resolver: refuses (throws CONFIG_INVALID with text safe to show) an endpoint that is not a public https host, and one whose
   * name now resolves to an address Rovara must not reach. Absent: an endpoint source cannot be saved.
   */
  checkEndpoint?: (url: string) => Promise<void>;
  /** Rovara's roles that assume a Bedrock source's role (the model proxy's task role, the function that probes the trust policy), for the policy an admin pastes. */
  bedrockTrustPrincipals?: readonly string[];
  /** Whether Pi's catalog knows a model. Default: `catalogModel(model) !== undefined`. */
  isKnownCatalog?: (model: ModelIdentifier) => boolean;
}

type Deps = AgentRouteDependencies & { modelSources: ModelSourceRouteDependencies };
type Source = StoredModelSources["sources"][number];
type HostStatus = "pending" | "approved" | "rejected" | "not_requested";

const LIST_PATH = "/v1/app/org/model-sources";
const ORDER_PATH = "/v1/app/org/model-sources-order";
const ITEM_PATH = /^\/v1\/app\/org\/model-sources\/([^/]+)(?:\/(check))?$/;
/** Called only by the trusted cookie adapter; share the exact path matchers with the handlers. */
export function requireReviewedModelSourceWebWrite(request: AdaptedHttpRequest, url: URL): void {
  if (request.method === "PUT" && url.pathname === ORDER_PATH && !ReviewedSourceOrderBodySchema.required({ expectedOrgId: true, expectedDeveloperId: true }).safeParse(jsonBody(request)).success) {
    throw agentXError("CONFIG_INVALID", "Review a valid company source order before submitting.");
  }
  const item = ITEM_PATH.exec(url.pathname);
  // Legacy removal changes routing order without the reviewed revision/authority fences.
  if (request.method === "DELETE" && item !== null && item[2] === undefined) {
    throw agentXError("FORBIDDEN", "Removing a company AI source is not available in the console yet.");
  }
}

const MISSING = "no AI source has that ID";
const ADMIN_ONLY = "Only an org owner or admin can change the company's AI sources.";
const CHECK_RACED = "this source changed while it was being tested; run the check again";

// ---- bodies

const RequestId = z.string().uuid();
const WriteBodySchema = z.object({ requestId: RequestId, source: z.unknown(), apiKey: z.string().optional() }).strict();
const RequestOnlySchema = z.object({ requestId: RequestId }).strict();
const OrderBodySchema = z.object({ requestId: RequestId, order: z.array(ModelSourceIdSchema).max(20) }).strict();
/** A vendor key: printable ASCII with no space, and long enough to be one. It is never repeated in a refusal. */
const API_KEY = /^[\x21-\x7e]{8,4096}$/;

/** A refusal of a body. It names the field and the rule, never a value or an unknown field's name: a refusal reaches logs and other people's screens. */
function bodyProblem(error: z.ZodError, base = "body"): AgentXError {
  const issue = error.issues[0];
  const path = [base === "body" ? [] : [base], issue?.path.map(String) ?? []].flat().join(".") || "body";
  if (issue?.code === "unrecognized_keys") {
    return agentXError("CONFIG_INVALID", `${path}: has a field Rovara doesn't accept${path.startsWith("source") ? "; sourceId, externalId and tested are set by Rovara and can't be sent" : ""}`);
  }
  return agentXError("CONFIG_INVALID", `${path}: ${issue?.message ?? "is not valid"}`);
}

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw bodyProblem(parsed.error);
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

// ---- the same request again (R18)

function fingerprintOf(route: string, subject: string, body: unknown): string {
  return createHash("sha256").update(canonicalJson({ route, subject, body }), "utf8").digest("hex");
}

async function markRequest(deps: Deps, caller: AgentCaller, route: string, subject: string, requestId: string, body: unknown): Promise<{ mark: RequestMark; replay?: { result: unknown } }> {
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId, fingerprint: fingerprintOf(route, subject, body) };
  const earlier = await deps.modelSources.store.getRequest(caller.orgId, caller.developerId, requestId);
  if (earlier === undefined) return { mark };
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  return { mark, replay: { result: earlier.result } };
}

// ---- access

function requireAdmin(caller: AgentCaller): void {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", ADMIN_ONLY);
}

// ---- endpoints

/** A plain DNS name: letters, digits and hyphens in dot-separated labels, two or more of them. No wildcard, underscore or other shape `new URL` lets through. */
const PLAIN_DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The host of an endpoint's base URL once it is a plain public https host, or the refusal. Task 12b's checker does the same and also resolves the name; this
 * is the check at this boundary. A base URL is shown to every member, so it carries no query or fragment (a key could ride in one).
 */
function endpointHost(baseUrl: string): { host: string } | { problem: string } {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return { problem: "source.baseUrl: is not a URL" }; }
  if (url.protocol !== "https:") return { problem: "source.baseUrl: must start with https://" };
  if (url.username !== "" || url.password !== "") return { problem: "source.baseUrl: must not hold a user name or password" };
  if (url.port !== "" && url.port !== "443") return { problem: "source.baseUrl: must use port 443" };
  // `url.search` is empty for a bare `?`, so the text is looked at too.
  if (url.search !== "" || url.hash !== "" || baseUrl.includes("?") || baseUrl.includes("#")) return { problem: "source.baseUrl: must not have a query or a fragment" };
  const host = url.hostname;
  if (!PLAIN_DNS_NAME.test(host) || !isAllowedDomain(host) || /(^|\.)(localhost|internal|local)$/.test(host)) return { problem: "source.baseUrl: the host must be a public domain name such as llm.acme.dev" };
  return { host };
}

function hostStatusOf(item: EgressDomainsItem | undefined, host: string): HostStatus {
  return item?.domains.find((entry) => entry.domain === host)?.status ?? "not_requested";
}

/** Whether the firewall has not yet caught up with the last change to the approved domains (the sync marker is dirty). */
async function firewallApplying(deps: Deps): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: EGRESS_SYNC_KEY, ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return false;
  const marker = EgressSyncMarkerSchema.partial().safeParse(response.Item);
  // A marker that cannot be read is taken as not caught up: the check says to wait rather than pass.
  return !marker.success || (marker.data.dirtySeq ?? 0) > (marker.data.syncedSeq ?? 0);
}

/** Asks for the approval of an endpoint's host (anywhere but Rovara Cloud it is approved at once) and says where it stands. */
async function requestHost(deps: Deps, caller: AgentCaller, sourceId: string, host: string): Promise<{ hostStatus: HostStatus; message?: string; warning?: string }> {
  const { warning } = await putEgressDomains(deps.modelSources.egress, caller.orgId, { kind: "model-source", sourceId }, [host], { developerId: caller.developerId });
  const hostStatus = hostStatusOf(await readEgressDomains(deps.modelSources.egress, caller.orgId, { kind: "model-source", sourceId }), host);
  return { hostStatus, ...(hostStatus === "pending" ? { message: egressPendingWarning(host) } : {}), ...(warning === undefined ? {} : { warning }) };
}

const hostOf = (source: Source): string | undefined => (source.kind === "endpoint" ? new URL(source.baseUrl).hostname : undefined);

// ---- what the routes show

function viewOf(deps: Deps, orgId: OrgId, stored: StoredModelSources, source: Source, hostStatus: HostStatus | undefined): Record<string, unknown> {
  const common = { sourceId: source.sourceId, kind: source.kind, label: source.label, models: source.models, hasCredential: stored.credentials.includes(source.sourceId), inOrder: stored.order.includes(source.sourceId) };
  if (source.kind === "endpoint") return { ...common, baseUrl: source.baseUrl, api: source.api, hostStatus: hostStatus ?? "not_requested" };
  if (source.kind !== "bedrock") return common;
  const principals = deps.modelSources.bedrockTrustPrincipals;
  return {
    ...common, roleArn: source.roleArn, region: source.region, tested: source.tested, note: BEDROCK_NOT_TESTED_NOTE,
    ...(principals === undefined || principals.length === 0 ? {} : { trustPolicy: bedrockTrustPolicy(orgId, principals) }),
  };
}

async function listSources(deps: Deps, caller: AgentCaller): Promise<unknown> {
  let stored = await deps.modelSources.store.read(caller.orgId);
  if (stored.removing.length > 0) {
    // A read by anyone finishes what an earlier removal left; it is Rovara's own work, so no person is named for it.
    await finishOwedRemovals(deps, caller);
    stored = await deps.modelSources.store.read(caller.orgId);
  }
  const sources = await Promise.all(stored.sources.map(async (source) => {
    const host = hostOf(source);
    const status = host === undefined ? undefined : hostStatusOf(await readEgressDomains(deps.modelSources.egress, caller.orgId, { kind: "model-source", sourceId: source.sourceId }), host);
    return viewOf(deps, caller.orgId, stored, source, status);
  }));
  return {
    orgId: caller.orgId, developerId: caller.developerId, sources, order: stored.order, revision: stored.revision,
    ...(stored.assistantModel === undefined ? {} : { assistantModel: stored.assistantModel }),
    ...(stored.chatgptPreferredModel === undefined ? {} : { chatgptPreferredModel: stored.chatgptPreferredModel }),
  };
}

// ---- writes

/** The id of a source an add creates: the same for the same request, so a retry registers the same models, and different for every org, person and request. */
function newSourceId(caller: AgentCaller, requestId: string): string {
  const digits = BigInt(`0x${createHash("sha256").update(`${caller.orgId}\n${caller.developerId}\n${requestId}`, "utf8").digest("hex")}`).toString(36);
  return `src_${digits.slice(0, 20)}`;
}

/** The kind (and an endpoint's api) a body claims, read before anything else is checked so the launch refusal never depends on the rest of the body. */
function claimedKind(source: unknown): { kind: z.infer<typeof ModelSourceKindSchema>; api?: string } {
  const claim = typeof source === "object" && source !== null ? source as Record<string, unknown> : {};
  const kind = ModelSourceKindSchema.safeParse(claim.kind);
  if (!kind.success) throw agentXError("CONFIG_INVALID", "source.kind: name the kind of AI source");
  return { kind: kind.data, ...(typeof claim.api === "string" ? { api: claim.api } : {}) };
}

/** Refuses a kind that is not on, and a kind that is not a company source at all. */
function requireAvailable(deps: Deps, kind: z.infer<typeof ModelSourceKindSchema>, api: string | undefined): void {
  const problem = sourceKindProblem(kind, api, deps.modelSources.launch ?? {});
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", problem);
  if (kind === "rovara" || kind === "personal-chatgpt") throw agentXError("CONFIG_INVALID", `source.kind: ${kind} is always there; add a source of another kind`);
  if (kind === "endpoint" && deps.modelSources.checkEndpoint === undefined) throw agentXError("CONFIG_INVALID", "endpoint sources aren't available yet");
}

/** The input checked against the schema, with Pi's catalog, and the key against the kind. */
function checkInput(deps: Deps, source: unknown, apiKey: string | undefined): ModelSourceInput {
  const schema = modelSourceInputSchema({ isKnownCatalog: deps.modelSources.isKnownCatalog ?? ((model) => catalogModel(model) !== undefined) });
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw bodyProblem(parsed.error, "source");
  const input = parsed.data;
  if (apiKey !== undefined && !API_KEY.test(apiKey)) throw agentXError("CONFIG_INVALID", "apiKey: is not a valid API key");
  if (input.kind === "bedrock" && apiKey !== undefined) throw agentXError("CONFIG_INVALID", "apiKey: a bedrock source uses a role, not an API key");
  return input;
}

/** The source as the server stores it: the input, its id, and for Bedrock the external id and whether its role has been tested. */
function stored(caller: AgentCaller, input: ModelSourceInput, sourceId: string, previous: Source | undefined): ModelSource {
  if (input.kind !== "bedrock") return { ...input, sourceId };
  // A role or region the probe has not seen is untested again.
  const tested = previous?.kind === "bedrock" && previous.roleArn === input.roleArn && previous.region === input.region && previous.tested;
  return { ...input, sourceId, externalId: bedrockExternalId(caller.orgId), tested };
}

/** Where an endpoint's host stands now, after the checks that must pass before anything is written. */
async function checkEndpointInput(deps: Deps, input: ModelSourceInput): Promise<string | undefined> {
  if (input.kind !== "endpoint") return undefined;
  const found = endpointHost(input.baseUrl);
  if ("problem" in found) throw agentXError("CONFIG_INVALID", found.problem);
  // Each call is made before this one writes anything, and the checker resolves the name now.
  await deps.modelSources.checkEndpoint!(input.baseUrl);
  return found.host;
}

async function answerFor(deps: Deps, caller: AgentCaller, sourceId: string, source: Source | undefined): Promise<Record<string, unknown>> {
  const host = source === undefined ? undefined : hostOf(source);
  if (host === undefined) return { sourceId };
  const outcome = await requestHost(deps, caller, sourceId, host);
  return { sourceId, ...outcome };
}

/**
 * After a record write that failed, makes the proxy match the record as it is now: a source the record has is registered as the record says (a key
 * cannot be read back, so it stays as the proxy holds it), one it lacks is removed. The record is the truth even when the failure said nothing about
 * whether the write landed. Best effort: the same request again, or a check, finishes what this could not.
 *
 * `dropKey`: the change sent a key and did not save. The proxy's credential is then this change's key, which the record is not committed to, and the
 * record's host may be another writer's (a refused save means that writer committed first). The source is removed (which deletes its credential) and
 * registered again with no key, and the record says it has none. A key is never kept at a host it was not saved for; the admin sends it again.
 */
async function reconcileRegistration(deps: Deps, caller: AgentCaller, sourceId: string, options: { dropKey?: boolean } = {}): Promise<void> {
  try {
    const found = (await deps.modelSources.store.read(caller.orgId)).sources.find((candidate) => candidate.sourceId === sourceId);
    if (found === undefined) {
      await deps.modelSources.access.removeSource(caller.orgId, sourceId);
    } else if (options.dropKey === true) {
      await deps.modelSources.access.removeSource(caller.orgId, sourceId);
      await deps.modelSources.access.upsertSource({ orgId: caller.orgId, source: found });
      await deps.modelSources.store.dropCredential({ orgId: caller.orgId, sourceId, by: caller.developerId });
    } else {
      await deps.modelSources.access.upsertSource({ orgId: caller.orgId, source: found });
    }
  } catch {
    // Nothing more can be done here, and what failed is not worth repeating: it could hold a key.
  }
}

/** Finishes the cleanup of removals that died part-way (their tombstones are in the record). It never fails the request that tried it: the next one, or the sweeper, tries again. */
async function finishOwedRemovals(deps: Deps, caller: AgentCaller, actor?: { developerId: string }): Promise<void> {
  try {
    await finishRemovals(deps.modelSources, caller.orgId, actor);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "model_sources.removal_unfinished", orgId: caller.orgId, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

async function addSource(deps: Deps, caller: AgentCaller, body: unknown): Promise<StatusReply> {
  requireAdmin(caller);
  await finishOwedRemovals(deps, caller, caller);
  const { requestId, source: raw, apiKey } = parseBody(WriteBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "model-source-create", "", requestId, { source: raw, hasKey: apiKey !== undefined });
  const sourceId = newSourceId(caller, requestId);
  if (replay !== undefined) {
    // The outcome is the stored one; an endpoint's host is asked for again, which changes nothing when it was and makes the request when it was not.
    const current = (await deps.modelSources.store.read(caller.orgId)).sources.find((candidate) => candidate.sourceId === sourceId);
    return new StatusReply(201, await answerFor(deps, caller, sourceId, current));
  }
  const claim = claimedKind(raw);
  requireAvailable(deps, claim.kind, claim.api);
  const input = checkInput(deps, raw, apiKey);
  if (apiKey === undefined && input.kind !== "bedrock" && input.kind !== "endpoint") throw agentXError("CONFIG_INVALID", `apiKey: ${/^[aeiou]/.test(input.kind) ? "an" : "a"} ${input.kind} source needs an API key`);
  const current = await deps.modelSources.store.read(caller.orgId);
  const tooMany = customSourceLimitProblem(current.sources.length);
  if (tooMany !== undefined) throw agentXError("CONFIG_INVALID", tooMany);
  const host = await checkEndpointInput(deps, input);
  const source = stored(caller, input, sourceId, undefined);
  await viaProxy(() => deps.modelSources.access.upsertSource({ orgId: caller.orgId, source, ...(apiKey === undefined ? {} : { apiKey }) }));
  try {
    await deps.modelSources.store.save({ orgId: caller.orgId, source, mode: "create", keyStored: apiKey !== undefined, by: caller.developerId, request: mark });
  } catch (error) {
    await reconcileRegistration(deps, caller, sourceId);
    throw error;
  }
  return new StatusReply(201, host === undefined ? { sourceId } : { sourceId, ...await requestHost(deps, caller, sourceId, host) });
}

async function changeSource(deps: Deps, caller: AgentCaller, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  requireAdmin(caller);
  await finishOwedRemovals(deps, caller, caller);
  const { requestId, source: raw, apiKey } = parseBody(WriteBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "model-source-change", rawId, requestId, { source: raw, hasKey: apiKey !== undefined });
  const before = await deps.modelSources.store.read(caller.orgId);
  const previous = ModelSourceIdSchema.safeParse(rawId).success ? before.sources.find((candidate) => candidate.sourceId === rawId) : undefined;
  if (replay !== undefined) return answerFor(deps, caller, rawId, previous);
  if (previous === undefined) throw agentXError("NOT_FOUND", MISSING);
  const claim = claimedKind(raw);
  requireAvailable(deps, claim.kind, claim.api);
  const input = checkInput(deps, raw, apiKey);
  if (input.kind !== previous.kind) throw agentXError("CONFIG_INVALID", "source.kind: a source's kind can't change; remove it and add a new one");
  const host = await checkEndpointInput(deps, input);
  const hostChanged = host !== undefined && hostOf(previous) !== host;
  // A saved key goes only to the host it was saved for. This is checked on `before`, and the save below holds only while the record is still at `before`.
  if (host !== undefined && apiKey === undefined && before.credentials.includes(previous.sourceId) && hostChanged) {
    throw agentXError("CONFIG_INVALID", "source.baseUrl: the saved key would be sent to a different host; send the new key with it");
  }
  const source = stored(caller, input, previous.sourceId, previous);
  await viaProxy(() => deps.modelSources.access.upsertSource({ orgId: caller.orgId, source, ...(apiKey === undefined ? {} : { apiKey }) }));
  try {
    await deps.modelSources.store.save({ orgId: caller.orgId, source, mode: "update", keyStored: apiKey !== undefined, by: caller.developerId, request: mark, expect: { revision: before.revision } });
  } catch (error) {
    await reconcileRegistration(deps, caller, previous.sourceId, { dropKey: apiKey !== undefined });
    throw error;
  }
  return host === undefined ? { sourceId: previous.sourceId } : { sourceId: previous.sourceId, ...await requestHost(deps, caller, previous.sourceId, host) };
}

async function removeSource(deps: Deps, caller: AgentCaller, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  requireAdmin(caller);
  await finishOwedRemovals(deps, caller, caller);
  const { requestId } = parseBody(RequestOnlySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "model-source-remove", rawId, requestId, {});
  if (replay !== undefined) {
    const done = replay.result as { sourceId: string; kind: string };
    await releaseSource(deps.modelSources, caller.orgId, done.sourceId, caller);
    await deps.modelSources.store.finishRemoval({ orgId: caller.orgId, sourceId: done.sourceId });
    return { sourceId: done.sourceId, removed: true };
  }
  const removed = await deps.modelSources.store.remove({ orgId: caller.orgId, sourceId: rawId, by: caller.developerId, request: mark });
  await releaseSource(deps.modelSources, caller.orgId, removed.sourceId, caller);
  await deps.modelSources.store.finishRemoval({ orgId: caller.orgId, sourceId: removed.sourceId });
  return { sourceId: removed.sourceId, removed: true };
}

async function putOrder(deps: Deps, caller: AgentCaller, body: unknown): Promise<Record<string, unknown>> {
  requireAdmin(caller);
  if (typeof body === "object" && body !== null && "expectedRevision" in body) {
    const reviewed = ReviewedSourceOrderBodySchema.safeParse(body);
    if (!reviewed.success) throw agentXError("CONFIG_INVALID", "Review a valid company source order before submitting.");
    const { requestId, order, expectedRevision, expectedOrgId, expectedDeveloperId } = reviewed.data;
    // Preserve tombstones for the sweeper: cleanup must not precede the reviewed atomic write.
    // RequestMark requires fingerprint, but only the reviewed digest binds this path; no legacy receipt is used.
    return deps.modelSources.store.setOrder({ orgId: caller.orgId, by: caller.developerId, order, expectedRevision, expectedOrgId, expectedDeveloperId, request: { orgId: caller.orgId, developerId: caller.developerId, requestId, fingerprint: fingerprintOf("reviewed-source-order", "", { order, expectedRevision }) } });
  }
  await finishOwedRemovals(deps, caller, caller);
  const { requestId, order } = parseBody(OrderBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "model-source-order", "", requestId, { order });
  if (replay !== undefined) return replay.result as Record<string, unknown>;
  return deps.modelSources.store.setOrder({ orgId: caller.orgId, order, by: caller.developerId, request: mark });
}

// ---- check

async function checkSource(deps: Deps, caller: AgentCaller, rawId: string): Promise<Record<string, unknown>> {
  requireAdmin(caller);
  const current = await deps.modelSources.store.read(caller.orgId);
  const source = ModelSourceIdSchema.safeParse(rawId).success ? current.sources.find((candidate) => candidate.sourceId === rawId) : undefined;
  if (source === undefined) throw agentXError("NOT_FOUND", MISSING);
  requireAvailable(deps, source.kind, source.kind === "endpoint" ? source.api : undefined);
  if (source.kind === "endpoint") {
    const host = hostOf(source)!;
    // The name is resolved again now: an address that was public when the source was saved can have moved.
    try {
      await deps.modelSources.checkEndpoint!(source.baseUrl);
    } catch (error) {
      if (error instanceof AgentXError && error.code === "CONFIG_INVALID") return { ok: false, message: error.message.replace(/^CONFIG_INVALID: /, "") };
      throw error;
    }
    // A host that was never asked for (the request after the save did not happen) is asked for now.
    let status = hostStatusOf(await readEgressDomains(deps.modelSources.egress, caller.orgId, { kind: "model-source", sourceId: source.sourceId }), host);
    if (status === "not_requested") status = (await requestHost(deps, caller, source.sourceId, host)).hostStatus;
    if (status === "pending") return { ok: false, message: egressPendingWarning(host) };
    if (status === "rejected") {
      const entry = (await readEgressDomains(deps.modelSources.egress, caller.orgId, { kind: "model-source", sourceId: source.sourceId }))?.domains.find((candidate) => candidate.domain === host);
      return { ok: false, message: egressRejectedWarning(host, entry?.reason) };
    }
    if (await firewallApplying(deps)) return { ok: false, message: MODEL_SOURCE_STILL_APPLYING };
  }
  const answer = await viaProxy(() => deps.modelSources.access.checkSource(caller.orgId, source.sourceId));
  if (!answer.ok) return { ok: false, message: answer.message };
  if (source.kind === "bedrock") {
    // The probe passed: the role is tested, and the proxy serves its models from now on. Both steps can be repeated, so a check also finishes a failed earlier one.
    // It is the role that was probed that is marked, and registered: if the source is no longer the one that was read, nothing is saved or registered.
    const tested = { ...source, tested: true };
    try {
      if (!source.tested) {
        await deps.modelSources.store.save({ orgId: caller.orgId, source: tested, mode: "update", by: caller.developerId, expect: { source } });
      } else if (canonicalJson((await deps.modelSources.store.read(caller.orgId)).sources.find((candidate) => candidate.sourceId === source.sourceId)) !== canonicalJson(source)) {
        return { ok: false, message: CHECK_RACED };
      }
    } catch (error) {
      if (error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT") return { ok: false, message: CHECK_RACED };
      throw error;
    }
    await viaProxy(() => deps.modelSources.access.upsertSource({ orgId: caller.orgId, source: tested }));
  }
  return { ok: true };
}

// ---- routing

/**
 * The company AI source routes, or undefined for a path that is not one of them. An install with no model proxy answers all of them with
 * `MODEL_SOURCES_NEED_PROXY`, to a member as to an admin.
 */
export async function routeModelSourceRequest(deps: AgentRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const path = url.pathname;
  const item = ITEM_PATH.exec(path);
  if (path !== LIST_PATH && path !== ORDER_PATH && item === null) return undefined;
  if (deps.modelSources === undefined) throw agentXError("CONFIG_INVALID", MODEL_SOURCES_NEED_PROXY);
  const withSources = deps as Deps;
  const method = request.method;
  if (path === LIST_PATH) {
    if (method === "GET") return listSources(withSources, caller);
    if (method === "POST") return addSource(withSources, caller, jsonBody(request));
  } else if (path === ORDER_PATH) {
    if (method === "PUT") return putOrder(withSources, caller, jsonBody(request));
  } else if (item !== null) {
    const [, id, sub] = item;
    if (sub === undefined && method === "PUT") return changeSource(withSources, caller, id!, jsonBody(request));
    if (sub === undefined && method === "DELETE") return removeSource(withSources, caller, id!, jsonBody(request));
    if (sub === "check" && method === "POST") return checkSource(withSources, caller, id!);
  }
  throw agentXError("NOT_FOUND", "route not found");
}
