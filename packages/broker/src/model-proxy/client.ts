// Broker client for the LiteLLM model proxy (docs/learnings/model-proxy-spike.md). A LiteLLM team is
// an org (team_id = orgId), a LiteLLM user is a developer (user_id = developerId), and a task or turn
// runs on a short-lived virtual key scoped to both. Caps reset on the 1st of each month, UTC
// (budget_duration "1mo"). It holds the master key only through the `masterKey` callback, reads it
// once per call, and never puts it, or a key, in an error. Network failures and 5xx answers are
// MODEL_PROXY_UNAVAILABLE; a 4xx carries the proxy's message.
import { randomBytes } from "node:crypto";
import { AgentXError, INFERENCE_PATHS, agentXError, bedrockExternalId, modelSourceOrgProblem, type OrgId } from "@agentx/contracts";
import type { MemberSpend, MintKeyInput, MintedKey, ModelAccess, SourceCheck, SpendFigures, UpsertSourceInput } from "./access.js";
import { credentialNameOf, proxyModelsOf, sourceAliasPrefix, sourceUsesKey, type PriceLookup } from "./sources.js";

const BUDGET_DURATION = "1mo";
/**
 * Ruling R48: a task or turn key may call LiteLLM's model routes only, never its management routes (teams, users, keys, spend), and
 * its user is a viewer. A second layer behind the load balancer, which forwards inference paths only.
 */
const KEY_ALLOWED_ROUTES = ["llm_api_routes"];
/**
 * A key minted for named models may call the three inference paths and nothing else: exact route strings, because the group name
 * `llm_api_routes` also opens GET /model/info (spike, question 2d).
 */
const KEY_INFERENCE_ROUTES: string[] = INFERENCE_PATHS.map((entry) => entry.path);
const USER_ROLE = "internal_user_viewer";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 300;
const KEY_INFO_AT_ONCE = 10;

/** Assumes a customer's role to test its trust policy. Resolves true when the role was assumed and false when AWS denied it; anything else throws. */
export interface RoleAssumer {
  assumeRole(input: { roleArn: string; sessionName: string; externalId: string }): Promise<boolean>;
}

export interface ModelProxyClientInput {
  baseUrl: string;
  masterKey: () => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  /** Pi's list prices; a source model without one is refused. */
  prices?: PriceLookup;
  /** The Rovara AI catalog model names every org team may also use. Required to touch a team's `models`: an empty list would mean every model. */
  catalog?: readonly string[];
  /** For the Bedrock probe. */
  roles?: RoleAssumer;
  /** Twenty lowercase base-36 characters; replaceable so a test can name the wrong external id. */
  random?: () => string;
}

interface ProxyModelEntry { id: string; name: string; org: string | undefined; roleArn: string | undefined }

type Json = Record<string, unknown>;
interface Reply { status: number; body: unknown }

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const unavailable = (message: string) => agentXError("MODEL_PROXY_UNAVAILABLE", message);

/** The proxy's own words for a refusal, with anything shaped like a key removed and the length capped. */
function proxyMessage(body: unknown): string {
  let text = "";
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") text = error.message;
    else if (typeof error === "string") text = error;
    else if (typeof body.detail === "string") text = body.detail;
    else if (isRecord(body.detail) && typeof body.detail.error === "string") text = body.detail.error;
  }
  return text.replace(/sk-[A-Za-z0-9_-]+/gu, "[key]").slice(0, MAX_MESSAGE_LENGTH);
}

function refusal(reply: Reply): AgentXError {
  const message = `model proxy refused the request (${String(reply.status)}): ${proxyMessage(reply.body) || "no reason given"}`;
  return agentXError(reply.status === 404 ? "NOT_FOUND" : "CONFIG_INVALID", message);
}

const randomBase36 = (): string => Array.from(randomBytes(20), (byte) => (byte % 36).toString(36)).join("");

/** An error with every occurrence of a secret removed from its text (the vendor key can come back inside a proxy refusal). */
function scrubbed(error: unknown, secret: string | undefined): unknown {
  if (secret === undefined || !(error instanceof AgentXError) || !error.message.includes(secret)) return error;
  return agentXError(error.code, error.message.slice(error.code.length + 2).replaceAll(secret, "[key]"));
}

/** A key may name only this org's aliases and the Rovara AI catalog: never a wildcard, an access group or another org's alias. */
function assertKeyModels(orgId: OrgId, models: readonly string[]): void {
  if (models.length === 0) throw agentXError("CONFIG_INVALID", "a key needs at least one model");
  for (const model of models) {
    const own = model.startsWith(`${orgId}.`);
    if (!own && (model.includes("*") || model === "all-proxy-models" || model.startsWith("org_"))) throw agentXError("CONFIG_INVALID", "a key may name only this organization's models");
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function figures(info: unknown, what: string): SpendFigures {
  const spent = isRecord(info) ? (info.spend === null ? 0 : numberOf(info.spend)) : undefined;
  const limit = isRecord(info) ? numberOf(info.max_budget) : undefined;
  if (spent === undefined || limit === undefined) throw unavailable(`model proxy answered with no ${what} budget`);
  return { spentUsd: spent, limitUsd: limit };
}

export class ModelProxyClient implements ModelAccess {
  private readonly baseUrl: string;

  constructor(private readonly input: ModelProxyClientInput) {
    this.baseUrl = input.baseUrl.replace(/\/+$/u, "");
  }

  async upsertOrg(orgId: OrgId, monthlyBudgetUsd: number): Promise<void> {
    const body = { team_id: orgId, max_budget: monthlyBudgetUsd, budget_duration: BUDGET_DURATION };
    await this.createOrUpdate("/team/new", "/team/update", body);
  }

  async upsertMember(orgId: OrgId, developerId: string, monthlyBudgetUsd: number): Promise<void> {
    const body = { user_id: developerId, user_role: USER_ROLE, max_budget: monthlyBudgetUsd, budget_duration: BUDGET_DURATION, metadata: { orgId } };
    // No key comes with the user: keys are minted per task or turn.
    await this.createOrUpdate("/user/new", "/user/update", { ...body, auto_create_key: false }, body);
  }

  async spend(orgId: OrgId, developerId: string): Promise<MemberSpend> {
    const master = await this.master();
    const [team, user] = await Promise.all([
      this.request("GET", `/team/info?team_id=${encodeURIComponent(orgId)}`, master, undefined),
      this.request("GET", `/user/info?user_id=${encodeURIComponent(developerId)}`, master, undefined),
    ]);
    for (const reply of [team, user]) if (reply.status !== 200) throw refusal(reply);
    return {
      member: figures(isRecord(user.body) ? user.body.user_info : undefined, "member"),
      org: figures(isRecord(team.body) ? team.body.team_info : undefined, "org"),
    };
  }

  async orgSpend(orgId: OrgId): Promise<SpendFigures> {
    const reply = await this.request("GET", `/team/info?team_id=${encodeURIComponent(orgId)}`, await this.master(), undefined);
    if (reply.status !== 200) throw refusal(reply);
    return figures(isRecord(reply.body) ? reply.body.team_info : undefined, "org");
  }

  async keySpend(keyIds: readonly string[]): Promise<number> {
    const unique = [...new Set(keyIds)];
    if (unique.length === 0) return 0;
    const master = await this.master();
    let total = 0;
    for (let start = 0; start < unique.length; start += KEY_INFO_AT_ONCE) {
      const replies = await Promise.all(unique.slice(start, start + KEY_INFO_AT_ONCE).map((id) => this.request("GET", `/key/info?key=${encodeURIComponent(id)}`, master, undefined)));
      for (const reply of replies) {
        // Fail closed: a key the proxy cannot find (deleted, or a hashed-token lookup it does not support) has spent an unknown
        // amount, and counting it as 0 would hand a task its whole budget again. The caller refuses the mint instead.
        if (reply.status === 404) throw unavailable("model proxy does not know a key of this task");
        if (reply.status !== 200) throw refusal(reply);
        const info = isRecord(reply.body) ? reply.body.info : undefined;
        const spent = isRecord(info) ? (info.spend === null ? 0 : numberOf(info.spend)) : undefined;
        if (spent === undefined) throw unavailable("model proxy answered with no key spend");
        total += spent;
      }
    }
    return total;
  }

  async mintKey(input: MintKeyInput): Promise<MintedKey> {
    const requestedAt = this.input.now();
    if (input.models !== undefined) assertKeyModels(input.orgId, input.models);
    const tags = input.tags === undefined ? {} : Object.fromEntries(Object.entries(input.tags).filter(([, value]) => value !== undefined));
    const reply = await this.call("POST", "/key/generate", {
      team_id: input.orgId,
      ...(input.developerId === undefined ? {} : { user_id: input.developerId }),
      max_budget: input.maxBudgetUsd,
      ...(input.models === undefined ? {} : { models: [...input.models] }),
      allowed_routes: input.models === undefined ? KEY_ALLOWED_ROUTES : KEY_INFERENCE_ROUTES,
      duration: `${String(input.ttlSeconds)}s`,
      metadata: { orgId: input.orgId, ...(input.developerId === undefined ? {} : { developerId: input.developerId }), purpose: input.purpose, refId: input.refId, ...tags },
    });
    const key = isRecord(reply.body) ? reply.body.key : undefined;
    if (typeof key !== "string" || key === "") throw unavailable("model proxy answered with no key");
    return { key, expiresAt: requestedAt + input.ttlSeconds * 1000 };
  }

  async revokeKey(key: string): Promise<void> {
    const master = await this.master();
    const reply = await this.request("POST", "/key/delete", master, { keys: [key] });
    // A key that is already gone is revoked.
    if (reply.status === 404) return;
    if (reply.status !== 200) throw refusal(reply);
  }

  async upsertSource(input: UpsertSourceInput): Promise<void> {
    try {
      await this.registerSource(input);
    } catch (error) {
      throw scrubbed(error, input.apiKey);
    }
  }

  private async registerSource({ orgId, source, apiKey }: UpsertSourceInput): Promise<void> {
    const problem = modelSourceOrgProblem(orgId, source);
    if (problem !== undefined) throw agentXError("CONFIG_INVALID", problem);
    const prices = this.input.prices;
    if (prices === undefined) throw agentXError("CONFIG_INVALID", "model prices are not configured");
    const catalog = this.teamCatalog();
    const master = await this.master();
    const credentialName = credentialNameOf(orgId, source.sourceId);
    // Reads first, so a source that cannot be built is refused before anything is written.
    const stored = source.kind === "bedrock" ? false : await this.credentialExists(master, credentialName);
    if (apiKey === undefined && !stored && sourceUsesKey(source)) throw agentXError("CONFIG_INVALID", "this source has no stored key; send one");
    const wanted = proxyModelsOf(orgId, source, apiKey !== undefined || stored ? credentialName : undefined, prices);
    const existing = await this.listModels(master);
    const prefix = sourceAliasPrefix(orgId, source.sourceId);
    const mine = existing.filter((entry) => entry.org === orgId && entry.name.startsWith(prefix));
    const names = new Set(wanted.map((model) => model.model_name));
    // The alias carries the org, so another org cannot own one of these names; a deployment that does is a collision LiteLLM would load-balance across.
    if (existing.some((entry) => names.has(entry.name) && entry.org !== orgId)) throw agentXError("CONFIG_INVALID", "a model with this alias already exists");
    if (apiKey !== undefined) {
      const credential = { credential_name: credentialName, credential_values: { api_key: apiKey, ...(source.kind === "endpoint" ? { api_base: source.baseUrl } : {}) }, credential_info: { rovara_org: orgId, rovara_source: source.sourceId } };
      const written = stored
        ? await this.request("PATCH", `/credentials/${encodeURIComponent(credentialName)}`, master, credential)
        : await this.request("POST", "/credentials", master, credential);
      if (written.status !== 200) throw refusal(written);
    }
    // New deployments first, then the old ones go: the alias never stops serving. The old ids are the ones listed above.
    const created = await Promise.all(wanted.map((model) => this.request("POST", "/model/new", master, { ...model })));
    for (const reply of created) if (reply.status !== 200) throw refusal(reply);
    await this.deleteModels(master, mine.map((entry) => entry.id));
    const others = existing.filter((entry) => entry.org === orgId && !entry.name.startsWith(prefix)).map((entry) => entry.name);
    await this.setTeamModels(master, orgId, [...others, ...names], catalog);
  }

  async removeSource(orgId: OrgId, sourceId: string): Promise<void> {
    const catalog = this.teamCatalog();
    const master = await this.master();
    const existing = await this.listModels(master);
    const prefix = sourceAliasPrefix(orgId, sourceId);
    const mine = existing.filter((entry) => entry.org === orgId && entry.name.startsWith(prefix));
    // The team first: it takes the aliases away at once on every replica, while a deleted model lingers on a replica for up to about 30 seconds.
    await this.setTeamModels(master, orgId, existing.filter((entry) => entry.org === orgId && !entry.name.startsWith(prefix)).map((entry) => entry.name), catalog);
    await this.deleteModels(master, mine.map((entry) => entry.id));
    const removed = await this.request("DELETE", `/credentials/${encodeURIComponent(credentialNameOf(orgId, sourceId))}`, master, undefined);
    // A source with no key (Bedrock) has no credential to remove.
    if (removed.status !== 200 && removed.status !== 404) throw refusal(removed);
  }

  async checkSource(orgId: OrgId, sourceId: string): Promise<SourceCheck> {
    const master = await this.master();
    const prefix = sourceAliasPrefix(orgId, sourceId);
    const mine = (await this.listModels(master)).filter((entry) => entry.org === orgId && entry.name.startsWith(prefix));
    if (mine.length === 0) throw agentXError("NOT_FOUND", "this source is not registered with the model proxy");
    const roleArn = mine.find((entry) => entry.roleArn !== undefined)?.roleArn;
    if (roleArn !== undefined) {
      const refused = await this.probeTrustPolicy(orgId, roleArn);
      if (refused !== undefined) return { ok: false, message: refused };
    }
    const replies = await Promise.all(mine.map((entry) => this.request("GET", `/health?model_id=${encodeURIComponent(entry.id)}`, master, undefined)));
    let healthy = 0;
    for (const reply of replies) {
      if (reply.status !== 200) throw refusal(reply);
      const body = isRecord(reply.body) ? reply.body : {};
      // Never the body: an unhealthy entry carries the request, with a partly masked key.
      if ((numberOf(body.unhealthy_count) ?? 0) > 0) return { ok: false, message: "this source did not answer a test call" };
      if ((numberOf(body.healthy_count) ?? 0) > 0) healthy += 1;
    }
    return { ok: true, health: healthy === replies.length ? "healthy" : "unknown" };
  }

  /**
   * The Bedrock probe: the role must be assumable with this org's external id, and must refuse a different one. A trust policy
   * with no external id condition, or one that matches by prefix, accepts the second and would let any other org's source
   * (or anyone who learns the role ARN) reach the customer's account through Rovara.
   */
  private async probeTrustPolicy(orgId: OrgId, roleArn: string): Promise<string | undefined> {
    const roles = this.input.roles;
    if (roles === undefined) throw unavailable("the role probe is not configured");
    const expected = bedrockExternalId(orgId);
    const attempt = async (externalId: string): Promise<boolean> => {
      try {
        return await roles.assumeRole({ roleArn, sessionName: "rovara-probe", externalId });
      } catch {
        throw unavailable("the role probe could not reach AWS");
      }
    };
    if (!(await attempt(expected))) return `Rovara could not assume this role with the external id ${expected}; check the role's trust policy`;
    if (await attempt(`rovara-org_${(this.input.random ?? randomBase36)()}`)) return `this role's trust policy must require the external id ${expected}`;
    return undefined;
  }

  private teamCatalog(): readonly string[] {
    const catalog = this.input.catalog ?? [];
    // A team whose `models` is empty can call every model, so a team is never written without the catalog.
    if (catalog.length === 0) throw agentXError("CONFIG_INVALID", "the Rovara AI model catalog is not configured");
    return catalog;
  }

  private async setTeamModels(master: string, orgId: OrgId, aliases: readonly string[], catalog: readonly string[]): Promise<void> {
    const reply = await this.request("POST", "/team/update", master, { team_id: orgId, models: [...new Set([...aliases, ...catalog])] });
    if (reply.status !== 200) throw refusal(reply);
  }

  private async deleteModels(master: string, ids: readonly string[]): Promise<void> {
    const replies = await Promise.all(ids.map((id) => this.request("POST", "/model/delete", master, { id })));
    for (const reply of replies) if (reply.status !== 200 && reply.status !== 404) throw refusal(reply);
  }

  private async credentialExists(master: string, name: string): Promise<boolean> {
    const reply = await this.request("GET", "/credentials", master, undefined);
    if (reply.status !== 200) throw refusal(reply);
    const credentials = isRecord(reply.body) && Array.isArray(reply.body.credentials) ? reply.body.credentials : [];
    return credentials.some((entry) => isRecord(entry) && entry.credential_name === name);
  }

  /** Every model the proxy holds, reduced to what the registry needs. The listing carries no key; nothing else is kept. */
  private async listModels(master: string): Promise<ProxyModelEntry[]> {
    const reply = await this.request("GET", "/model/info", master, undefined);
    if (reply.status !== 200) throw refusal(reply);
    const data = isRecord(reply.body) && Array.isArray(reply.body.data) ? reply.body.data : [];
    const entries: ProxyModelEntry[] = [];
    for (const item of data) {
      if (!isRecord(item) || typeof item.model_name !== "string" || !isRecord(item.model_info) || typeof item.model_info.id !== "string") continue;
      const info = item.model_info;
      entries.push({
        id: item.model_info.id,
        name: item.model_name,
        org: typeof info.rovara_org === "string" ? info.rovara_org : undefined,
        roleArn: typeof info.rovara_role_arn === "string" ? info.rovara_role_arn : undefined,
      });
    }
    return entries;
  }

  /** Creates the record; when the proxy says it already exists, the record is updated instead. Any other refusal is the create's own. */
  private async createOrUpdate(createPath: string, updatePath: string, createBody: Json, updateBody: Json = createBody): Promise<void> {
    const master = await this.master();
    const created = await this.request("POST", createPath, master, createBody);
    if (created.status === 200) return;
    // LiteLLM answers 400 for validation errors too, so only a 409 or an "already exists" 400 means the record is there.
    const exists = created.status === 409 || (created.status === 400 && /already exists/iu.test(proxyMessage(created.body)));
    if (!exists) throw refusal(created);
    const updated = await this.request("POST", updatePath, master, updateBody);
    if (updated.status !== 200) throw refusal(updated);
  }

  private async call(method: "POST", path: string, body: Json): Promise<Reply> {
    const reply = await this.request(method, path, await this.master(), body);
    if (reply.status !== 200) throw refusal(reply);
    return reply;
  }

  private async master(): Promise<string> {
    try {
      return await this.input.masterKey();
    } catch {
      throw unavailable("the model proxy master key could not be read");
    }
  }

  /** One HTTP exchange. Network failures and 5xx answers throw MODEL_PROXY_UNAVAILABLE; everything else is returned. */
  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, master: string, body: Json | undefined): Promise<Reply> {
    let response: Response;
    try {
      response = await this.input.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${master}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw unavailable("model proxy is unreachable");
    }
    if (response.status >= 500) throw unavailable(`model proxy answered ${String(response.status)}`);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (response.status === 200 && !isRecord(parsed)) throw unavailable("model proxy answered with a body that is not JSON");
    return { status: response.status, body: parsed };
  }
}
