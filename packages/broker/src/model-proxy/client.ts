// Broker client for the LiteLLM model proxy (docs/learnings/model-proxy-spike.md). A LiteLLM team is
// an org (team_id = orgId), a LiteLLM user is a developer (user_id = developerId), and a task or turn
// runs on a short-lived virtual key scoped to both. Caps reset on the 1st of each month, UTC
// (budget_duration "1mo"). It holds the master key only through the `masterKey` callback, reads it
// once per call, and never puts it, or a key, in an error. Network failures and 5xx answers are
// MODEL_PROXY_UNAVAILABLE; a 4xx carries the proxy's message.
import { createHash, randomInt } from "node:crypto";
import { AgentXError, INFERENCE_PATHS, agentXError, bedrockExternalId, endpointSecretRefProblem, modelSourceOrgProblem, type OrgId } from "@agentx/contracts";
import type { KeyAudit, LearningCompletion, LearningCompletionInput, MemberSpend, MintKeyInput, MintedKey, ModelAccess, SourceCheck, SpendFigures, UpsertSourceInput } from "./access.js";
import { endpointQualified } from "../model-sources/endpoint-digest.js";
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
/** The LiteLLM team of the Rovara-paid diagnosis design (DG-1 S1, retired 2026-11-03). No key may answer to it; the audit blocks one that does. */
const RETIRED_SUPPORT_TEAM_ID = "rovara-support";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 300;
const KEY_INFO_AT_ONCE = 10;
/** The audit reads this many keys a page and stops after this many pages; the next run reads again (blocked and expired keys fall out of it). */
const AUDIT_PAGE_SIZE = 100;
export const AUDIT_MAX_PAGES = 30;

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
  /**
   * N8: reads the secret behind a company endpoint's reference (a name under `rovara/model-endpoints/`). Only the model access function, inside the VPC, has one. It throws an
   * AgentXError with a fixed message for a secret that is missing or not readable, and anything else for a read that may work later; it never puts the value in an error.
   */
  resolveSecret?: (reference: string) => Promise<string>;
  /** N8: judges a company endpoint's address inside the VPC (see `ModelAccess.checkEndpoint`). Absent: every address is refused. */
  checkEndpointHost?: (url: string) => Promise<void>;
  /** Twenty lowercase base-36 characters; replaceable so a test can name the wrong external id. */
  random?: () => string;
  /** Where the client says what it refused to rewrite. Never a key or a model name. */
  log?: (entry: Record<string, unknown>) => void;
}

/** `served` is false for a Bedrock source that has not passed its probe, and for an endpoint source no check has qualified: their models exist (the probe finds them) but no team may call them. */
interface ProxyModelEntry { id: string; name: string; org: string | undefined; roleArn: string | undefined; /** `endpoint` for a company's own model endpoint. */ kind: string | undefined; /** The wire format an endpoint is called in. */ api: string | undefined; served: boolean; /** The hostname the model's `api_base` points at, when it has one. */ host: string | undefined }

type Json = Record<string, unknown>;
interface Reply { status: number; body: unknown }

/** The lower-case hostname of a URL, or undefined for anything else (a masked or missing value): never a path, query or user info. */
function hostnameOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The most token usage any event of a streamed reply reports: a `usage` object on the event, on its `message` (Anthropic message_start) or on its `response` (OpenAI Responses
 * completed). Anthropic reports input in one event and output in another, so its two counts are added across events.
 */
function streamedUsageTotal(text: string): number {
  let total = 0, input = 0, output = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: unknown;
    try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    for (const holder of [record, record.message, record.response]) {
      const usage = typeof holder === "object" && holder !== null ? (holder as Record<string, unknown>).usage : undefined;
      if (typeof usage !== "object" || usage === null) continue;
      const counts = usage as Record<string, unknown>;
      total = Math.max(total, numberOf(counts.total_tokens) ?? ((numberOf(counts.prompt_tokens) ?? 0) + (numberOf(counts.completion_tokens) ?? 0)));
      input = Math.max(input, numberOf(counts.input_tokens) ?? 0);
      output = Math.max(output, numberOf(counts.output_tokens) ?? 0);
    }
  }
  return Math.max(total, input + output);
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const unavailable = (message: string) => agentXError("MODEL_PROXY_UNAVAILABLE", message);
const notScoped = () => agentXError("CONFIG_INVALID", "this organization's model team is not limited to its own models; ask a Rovara admin to look at it");

/** What a Rovara AI catalog id looks like (`<geography>.anthropic.claude-...`): a stale one is a retired or older id, which a team may be brought back from. */
const CATALOG_ID_SHAPE = /^[a-z]+\.anthropic\.claude-[a-z0-9.:_-]+$/iu;

/**
 * Why a non-empty team list is not one Rovara wrote, or undefined when every entry is the org's own alias or has a catalog id's shape (the lists that may be limited again).
 * Names are never returned: only the kind of entry.
 */
function unscopedReason(orgId: string, models: readonly unknown[]): "wildcard" | "foreign_alias" | "unknown_entry" | undefined {
  const ownPrefix = `${orgId}.`;
  const names = models.map((model) => (typeof model === "string" ? model : undefined));
  if (names.some((name) => name === undefined)) return "unknown_entry";
  const strings = names as string[];
  if (strings.some((name) => name.includes("*"))) return "wildcard";
  if (strings.some((name) => /^org_[0-9a-z]+\./u.test(name) && !name.startsWith(ownPrefix))) return "foreign_alias";
  if (strings.some((name) => !(name.startsWith(ownPrefix) && name.length > ownPrefix.length) && !CATALOG_ID_SHAPE.test(name))) return "unknown_entry";
  return undefined;
}

/** The proxy's own words for a refusal, with anything shaped like a key and the exact `secret` removed first, and only then the length capped. */
function proxyMessage(body: unknown, secret?: string): string {
  let text = "";
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") text = error.message;
    else if (typeof error === "string") text = error;
    else if (typeof body.detail === "string") text = body.detail;
    else if (isRecord(body.detail) && typeof body.detail.error === "string") text = body.detail.error;
  }
  // Scrub before truncating: a cut through the middle of a secret would leave its beginning in the message.
  if (secret !== undefined && secret !== "") text = text.replaceAll(secret, "[key]");
  return text.replace(/sk-[A-Za-z0-9_-]+/gu, "[key]").slice(0, MAX_MESSAGE_LENGTH);
}

function refusal(reply: Reply, secret?: string): AgentXError {
  const message = `model proxy refused the request (${String(reply.status)}): ${proxyMessage(reply.body, secret) || "no reason given"}`;
  return agentXError(reply.status === 404 ? "NOT_FOUND" : "CONFIG_INVALID", message);
}

// randomInt draws uniformly (rejection sampling); `byte % 36` would make the first 4 of 36 characters more likely.
const randomBase36 = (): string => Array.from({ length: 20 }, () => randomInt(36).toString(36)).join("");

/** An error with every occurrence of a secret removed from its text (the vendor key can come back inside a proxy refusal). */
function scrubbed(error: unknown, secret: string | undefined): unknown {
  if (secret === undefined || !(error instanceof AgentXError) || !error.message.includes(secret)) return error;
  return agentXError(error.code, error.message.slice(error.code.length + 2).replaceAll(secret, "[key]"));
}

/**
 * A key may name only this org's own aliases (`<orgId>.<sourceId>.<model>`) or exact Rovara AI catalog ids. Nothing else: no wildcard
 * of any kind (an own-prefixed one included), no access group, no raw provider name, no other org's alias.
 */
function assertKeyModels(orgId: OrgId, models: readonly string[], catalog: readonly string[]): void {
  if (models.length === 0) throw agentXError("CONFIG_INVALID", "a key needs at least one model");
  if (!models.every((model) => ownOrCatalog(orgId, model, catalog))) throw agentXError("CONFIG_INVALID", "a key may name only this organization's models and the Rovara AI catalog");
}

/** Whether a model name is one of this org's own aliases or an exact Rovara AI catalog id: never a wildcard, an access group or another org's alias. */
function ownOrCatalog(orgId: string, model: string, catalog: readonly string[]): boolean {
  const ownPrefix = `${orgId}.`;
  const own = model.startsWith(ownPrefix) && model.length > ownPrefix.length;
  return !model.includes("*") && (own || catalog.includes(model));
}

/** Whether two lists name the same models, whatever the order. */
const sameModels = (left: readonly unknown[], right: readonly string[]): boolean => left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n");

/** LiteLLM's token id for a key: the hex SHA-256 of it, which is also how its info is asked for. */
/** A learning key lives for at most five minutes. */
const LEARNING_KEY_TTL_SECONDS = 300;
/** One learning reply may take this long. */
const LEARNING_CALL_TIMEOUT_MS = 150_000;
const cleanCost = (usd: number): number => (Number.isFinite(usd) && usd > 0 ? Number(usd.toFixed(6)) : 0);

/** The path and tool-less body of a learning call in the route's own transport: a system text, one user message, an output limit; no tools field in any of them. */
function learningRequestOf(input: LearningCompletionInput): [string, Json] {
  switch (input.api) {
    case "anthropic-messages": return ["/v1/messages", { model: input.model, max_tokens: input.maxOutputTokens, system: input.system, messages: [{ role: "user", content: input.user }] }];
    case "openai-responses": return ["/v1/responses", { model: input.model, max_output_tokens: input.maxOutputTokens, instructions: input.system, input: input.user }];
    case "openai-completions": return ["/chat/completions", { model: input.model, max_tokens: input.maxOutputTokens, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] }];
  }
}

/** The text of a reply in each transport, or undefined when there is none. */
function learningTextOf(api: LearningCompletionInput["api"], body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const join = (parts: unknown[], pick: (part: Record<string, unknown>) => unknown): string => parts.flatMap((part) => (isRecord(part) && typeof pick(part) === "string" ? [pick(part) as string] : [])).join("");
  let text: string;
  if (api === "anthropic-messages") text = Array.isArray(body.content) ? join(body.content, (part) => (part.type === "text" ? part.text : undefined)) : "";
  else if (api === "openai-completions") {
    const first: unknown = Array.isArray(body.choices) ? (body.choices as unknown[])[0] : undefined;
    const message = isRecord(first) && isRecord(first.message) ? first.message.content : undefined;
    text = typeof message === "string" ? message : "";
  } else {
    text = typeof body.output_text === "string" ? body.output_text
      : Array.isArray(body.output) ? body.output.flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? [join(item.content, (part) => (part.type === "output_text" ? part.text : undefined))] : [])).join("") : "";
  }
  return text.trim() === "" ? undefined : text;
}

const tokenOf = (key: string): string => createHash("sha256").update(key).digest("hex");

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
    // Every team is limited to the Rovara AI catalog plus the org's own served aliases, whether or not it has sources: a team with empty
    // `models` can call every model, and org aliases exist once any org registers a source. Both the create and the update carry the
    // list, so a team left unscoped by an earlier deploy is brought in line by its next upsert (the deploy can call upsertOrg per org).
    const catalog = this.teamCatalog();
    const master = await this.master();
    const own = this.servedAliases(await this.listModels(master), orgId, catalog);
    const body = { team_id: orgId, max_budget: monthlyBudgetUsd, budget_duration: BUDGET_DURATION, models: [...new Set([...own, ...catalog])] };
    await this.createOrUpdate(master, "/team/new", "/team/update", body);
  }

  async upsertMember(orgId: OrgId, developerId: string, monthlyBudgetUsd: number): Promise<void> {
    const body = { user_id: developerId, user_role: USER_ROLE, max_budget: monthlyBudgetUsd, budget_duration: BUDGET_DURATION, metadata: { orgId } };
    // No key comes with the user: keys are minted per task or turn.
    await this.createOrUpdate(await this.master(), "/user/new", "/user/update", { ...body, auto_create_key: false }, body);
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
    // Every key, with a model list or without, answers to a team: a team with no models means every model of every org, so the team is
    // always read first and must itself be limited to the org's own models and the catalog (or be limited to them here, see requireScopedTeam).
    const catalog = this.teamCatalog();
    const team = input.orgId;
    if (input.models !== undefined) assertKeyModels(input.orgId, input.models, catalog);
    const master = await this.master();
    // validate_mint: a scoped key is only as narrow as its team lets it be.
    await this.requireScopedTeam(master, input.orgId, catalog, input.models ?? []);
    const tags = input.tags === undefined ? {} : Object.fromEntries(Object.entries(input.tags).filter(([, value]) => value !== undefined));
    const reply = await this.request("POST", "/key/generate", master, {
      team_id: team,
      ...(input.developerId === undefined ? {} : { user_id: input.developerId }),
      max_budget: input.maxBudgetUsd,
      ...(input.models === undefined ? {} : { models: [...input.models] }),
      allowed_routes: input.models === undefined ? KEY_ALLOWED_ROUTES : KEY_INFERENCE_ROUTES,
      duration: `${String(input.ttlSeconds)}s`,
      metadata: { orgId: input.orgId, ...(input.developerId === undefined ? {} : { developerId: input.developerId }), purpose: input.purpose, refId: input.refId, ...tags },
    });
    if (reply.status !== 200) throw refusal(reply);
    const key = isRecord(reply.body) ? reply.body.key : undefined;
    if (typeof key !== "string" || key === "") throw unavailable("model proxy answered with no key");
    if (input.models !== undefined) await this.verifyMinted(master, key, team, input.models);
    return { key, expiresAt: requestedAt + input.ttlSeconds * 1000 };
  }

  /**
   * The team's `models` must be non-empty (empty means every model) and hold only the org's own aliases and Rovara AI catalog ids.
   * Two states are Rovara's own doing and are limited again, here, to exactly the org's allowed models: no models at all (a team created before teams were scoped,
   * which nothing upserts again), and a list of catalog-shaped ids and own aliases that has gone stale (a retired catalog id, a catalog id added since). Anything else (a wildcard, another org's alias, an access group) is nothing Rovara writes: it is refused, logged, and left
   * as it is for a person to look at.
   */
  private async requireScopedTeam(master: string, orgId: OrgId, catalog: readonly string[], requested: readonly string[]): Promise<void> {
    const models = await this.readTeamModels(master, orgId);
    if (models !== undefined && models.length > 0) {
      const refused = unscopedReason(orgId, models);
      if (refused !== undefined) {
        this.input.log?.({ event: "model_access.team_refused", orgId, reason: refused });
        throw notScoped();
      }
      const held = models as string[];
      const current = held.every((model) => ownOrCatalog(orgId, model, catalog)) && catalog.every((model) => held.includes(model));
      if (current) return;
    }
    // The allowed models are the proxy's own: the org's served aliases (a removed source's are gone, a Bedrock source's before its probe has passed are not served) and the catalog.
    // They are read before anything is written, so a proxy that cannot say leaves the team and the mint as they were.
    const own = this.servedAliases(await this.listModels(master), orgId, catalog);
    const allowed = [...new Set([...own, ...catalog])];
    // Only the key's own models are measured against the allowed ones; the team is never widened to fit a request.
    if (!requested.every((model) => allowed.includes(model))) throw agentXError("CONFIG_INVALID", "a key may name only models this organization may use");
    await this.setTeamModels(master, orgId, own, catalog);
    const healed = await this.readTeamModels(master, orgId);
    if (healed === undefined || !healed.every((model) => typeof model === "string") || !sameModels(healed, allowed)) throw notScoped();
  }

  /** The org's served aliases among the proxy's models, kept only when they are named as the org's own (an entry that merely claims the org is not written to a team). */
  private servedAliases(entries: readonly ProxyModelEntry[], orgId: OrgId, catalog: readonly string[]): string[] {
    return entries.filter((entry) => entry.org === orgId && entry.served && ownOrCatalog(orgId, entry.name, catalog)).map((entry) => entry.name);
  }

  /** The team's `models` as the proxy holds them (undefined when it holds none). */
  private async readTeamModels(master: string, orgId: OrgId): Promise<unknown[] | undefined> {
    const reply = await this.request("GET", `/team/info?team_id=${encodeURIComponent(orgId)}`, master, undefined);
    if (reply.status !== 200) throw refusal(reply);
    const info = isRecord(reply.body) ? reply.body.team_info : undefined;
    return isRecord(info) && Array.isArray(info.models) ? info.models : undefined;
  }

  /**
   * verify_minted: the key as the proxy stored it is read back and must be exactly what was asked for (its models, no alias map, its team, its routes).
   * LiteLLM has stored a wildcard where a list was sent, so a key that differs, or cannot be read back, is revoked and never returned.
   */
  private async verifyMinted(master: string, key: string, team: string, requested: readonly string[]): Promise<void> {
    let drifted: boolean;
    try {
      const reply = await this.request("GET", `/key/info?key=${encodeURIComponent(tokenOf(key))}`, master, undefined);
      const info = reply.status === 200 && isRecord(reply.body) ? reply.body.info : undefined;
      drifted = !isRecord(info) || !Array.isArray(info.models) || !sameModels(info.models, requested) || info.team_id !== team
        || (isRecord(info.aliases) && Object.keys(info.aliases).length > 0) || (info.aliases !== undefined && info.aliases !== null && !isRecord(info.aliases))
        // The Task 25 spike shows the route list is stored and enforced, not that /key/info echoes it; a key whose info does not list it cannot be shown to be
        // limited to the inference routes, so it is refused (Task 37 checks the real shape on staging).
        || !Array.isArray(info.allowed_routes) || !sameModels(info.allowed_routes, KEY_INFERENCE_ROUTES);
    } catch {
      drifted = true;
    }
    if (!drifted) return;
    // Best effort: a key that cannot be revoked now still expires, and the audit blocks it; either way it is not returned.
    await this.request("POST", "/key/delete", master, { keys: [key] }).catch(() => undefined);
    throw unavailable("the model proxy issued a key that does not match the request");
  }

  async auditKeys(options: { budgetMs?: number } = {}): Promise<KeyAudit> {
    const catalog = this.teamCatalog();
    const master = await this.master();
    const started = this.input.now();
    const audit: KeyAudit = { checked: 0, blocked: 0, truncated: false };
    const overBudget = () => options.budgetMs !== undefined && this.input.now() - started >= options.budgetMs;
    let drifted = 0;
    let failed = 0;
    for (let page = 1; ; page += 1) {
      // Newest keys first, so a proxy that holds more keys than one run reads still has its recent ones audited; what is left unread is said so.
      if (page > AUDIT_MAX_PAGES || (page > 1 && overBudget())) {
        audit.truncated = true;
        break;
      }
      const reply = await this.request("GET", `/key/list?return_full_object=true&sort_by=created_at&sort_order=desc&size=${String(AUDIT_PAGE_SIZE)}&page=${String(page)}`, master, undefined);
      if (reply.status !== 200) throw refusal(reply);
      const body = isRecord(reply.body) ? reply.body : {};
      const entries: unknown[] = Array.isArray(body.keys) ? body.keys : [];
      // No page is skipped for holding only expired keys: keys have two lifetimes (a turn's, an operation's), so newer expired keys say nothing of older live ones.
      for (const entry of entries) {
        const verdict = this.auditVerdict(entry, catalog);
        if (verdict === undefined) continue;
        audit.checked += 1;
        if (!verdict.violation) continue;
        drifted += 1;
        // The budget is kept between blocks too: a page can hold a hundred drifted keys. What is left unblocked is said by `truncated`, and the next run starts again.
        if (overBudget()) { audit.truncated = true; break; }
        // One key that cannot be blocked does not leave the rest of the page unchecked; the audit fails at the end instead of reporting itself clean.
        try {
          await this.blockKey(verdict.token);
          audit.blocked += 1;
        } catch {
          failed += 1;
        }
      }
      if (audit.truncated || page >= (numberOf(body.total_pages) ?? 1)) break;
    }
    if (failed > 0) throw unavailable(`the audit could not block ${String(failed)} of ${String(drifted)} drifted keys (checked ${String(audit.checked)}, blocked ${String(audit.blocked)})`);
    return audit;
  }

  private isExpired(entry: unknown): boolean {
    return isRecord(entry) && typeof entry.expires === "string" && Date.parse(entry.expires) <= this.input.now();
  }

  /** Whether one listed key holds to its invariants; undefined for a key the audit does not cover (older unscoped, blocked, expired, or unreadable). */
  private auditVerdict(entry: unknown, catalog: readonly string[]): { token: string; violation: boolean } | undefined {
    if (!isRecord(entry) || typeof entry.token !== "string" || !/^[0-9a-f]{64}$/u.test(entry.token) || entry.blocked === true) return undefined;
    if (this.isExpired(entry)) return undefined;
    const models = Array.isArray(entry.models) ? entry.models : [];
    const routes = Array.isArray(entry.allowed_routes) ? entry.allowed_routes : [];
    const scopedRoutes = routes.length > 0 && routes.every((route) => typeof route === "string" && KEY_INFERENCE_ROUTES.includes(route));
    // The older key has no models and the group route; the team's own scoping bounds it. Anything with models, or with the exact routes, is a scoped key.
    if (models.length === 0 && !scopedRoutes) return undefined;
    const team = typeof entry.team_id === "string" ? entry.team_id : undefined;
    const metadataOrg = isRecord(entry.metadata) ? entry.metadata.orgId : undefined;
    // 2026-11-03: Rovara pays for no model key. A key of the retired `rovara-support` team (the Rovara-paid diagnosis design, never shipped) is a violation whatever it names, and is blocked.
    const violation = team === undefined || team === RETIRED_SUPPORT_TEAM_ID || models.length === 0 || !scopedRoutes
      || !models.every((model) => typeof model === "string" && ownOrCatalog(team, model, catalog))
      || (isRecord(entry.aliases) && Object.keys(entry.aliases).length > 0)
      || (typeof metadataOrg === "string" && metadataOrg !== team);
    return { token: entry.token, violation };
  }

  /**
   * Lessons in production: one tool-less model call on the company's own route, with a key made for it alone (see `LearningCompletionInput`). The key is for the org (no member), scoped to the one alias,
   * capped at the budget, alive for at most five minutes, used once and deleted. Every failure is a fixed sentence: the provider's words are never passed on, and neither is the key.
   */
  async learningCompletion(input: LearningCompletionInput): Promise<LearningCompletion> {
    const fail = (code: "MODEL_PROXY_UNAVAILABLE" | "CONFIG_INVALID" | "MODEL_NOT_ALLOWED", message: string): AgentXError => agentXError(code, message);
    let minted: MintedKey;
    try {
      minted = await this.mintKey({
        orgId: input.orgId, purpose: "turn", refId: `learning-${randomBase36()}`, maxBudgetUsd: input.maxBudgetUsd, ttlSeconds: LEARNING_KEY_TTL_SECONDS, models: [input.model],
        tags: { agentId: "learning", project: input.project, payerKind: "project", payerId: input.project, source: "learning", origin: "learning" },
      });
    } catch (error) {
      // The proxy's reason for a refusal is its own text: only its code is passed on.
      this.input.log?.({ event: "model_access.learning_mint_failed", code: error instanceof AgentXError ? error.code : "unknown" });
      throw fail(error instanceof AgentXError && error.code === "CONFIG_INVALID" ? "CONFIG_INVALID" : "MODEL_PROXY_UNAVAILABLE", "the learning model could not be reached");
    }
    const key = minted.key;
    try {
      const [path, body] = learningRequestOf(input);
      let reply: Reply;
      try {
        reply = await this.request("POST", path, key, body, LEARNING_CALL_TIMEOUT_MS);
      } catch {
        throw fail("MODEL_PROXY_UNAVAILABLE", "the learning model call failed");
      }
      if (reply.status !== 200) throw fail("MODEL_PROXY_UNAVAILABLE", "the learning model call failed");
      const text = learningTextOf(input.api, reply.body);
      if (text === undefined) throw fail("MODEL_PROXY_UNAVAILABLE", "the learning model answered with no text");
      return { text, costUsd: await this.learningCost(key, input), model: input.model };
    } finally {
      // The key was for this one call. A delete that fails leaves a five-minute key nobody holds.
      await this.revokeKey(key).catch(() => this.input.log?.({ event: "model_access.learning_revoke_failed" }));
    }
  }

  /** What the call cost: the proxy's own figure for the key; if it cannot say, the key's whole cap (never less than the call may have cost). */
  private async learningCost(key: string, input: LearningCompletionInput): Promise<number> {
    try {
      return cleanCost(await this.keySpend([tokenOf(key)]));
    } catch {
      return cleanCost(input.maxBudgetUsd);
    }
  }

  async revokeKey(key: string): Promise<void> {
    const master = await this.master();
    const reply = await this.request("POST", "/key/delete", master, { keys: [key] });
    // A key that is already gone is revoked.
    if (reply.status === 404) return;
    if (reply.status !== 200) throw refusal(reply);
  }

  async blockKey(keyId: string): Promise<void> {
    const reply = await this.request("POST", "/key/block", await this.master(), { key: keyId });
    // A key the proxy no longer knows is already blocked.
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
    // A Bedrock source authenticates by role and external id; a key beside them could be used as a bearer token and bypass both.
    if (source.kind === "bedrock" && apiKey !== undefined) throw agentXError("CONFIG_INVALID", "a Bedrock source uses a role, not an api key");
    // N8: an endpoint's secret is only ever a reference, read below; a key sent beside it would be a second, unreviewable way to hold one.
    if (source.kind === "endpoint" && apiKey !== undefined) throw agentXError("CONFIG_INVALID", "an endpoint source names its secret with a reference; it takes no pasted key");
    const prices = this.input.prices;
    if (prices === undefined) throw agentXError("CONFIG_INVALID", "model prices are not configured");
    const catalog = this.teamCatalog();
    const master = await this.master();
    const credentialName = credentialNameOf(orgId, source.sourceId);
    // The secret behind an endpoint's reference is read here, in this function, and goes straight to the proxy's credential store: it is never returned, logged or sent
    // anywhere else. It is read on every registration, so a rotated secret is picked up by the next save or check.
    // The reference must be this org's and named for this address's host before the function reads it (a second fence beside the routes').
    if (source.kind === "endpoint" && source.keyRef !== undefined && endpointSecretRefProblem(orgId, source.baseUrl, source.keyRef) !== undefined) throw agentXError("CONFIG_INVALID", "the endpoint's secret is not this organization's, or is not named for this address's host");
    const referenced = source.kind === "endpoint" && source.keyRef !== undefined ? await this.readReferencedSecret(source.keyRef) : undefined;
    const key = apiKey ?? referenced;
    try {
      // Reads first, so a source that cannot be built is refused before anything is written.
      const stored = source.kind === "bedrock" ? false : await this.credentialExists(master, credentialName, key);
      if (key === undefined && !stored && sourceUsesKey(source)) throw agentXError("CONFIG_INVALID", "this source has no stored key; send one");
      // An endpoint holds a credential only through its reference: one left from an earlier reference is not used (and is removed below).
      const usesCredential = key !== undefined || (stored && source.kind !== "endpoint");
      const wanted = proxyModelsOf(orgId, source, usesCredential ? credentialName : undefined, prices);
      const existing = await this.listModels(master, key);
      const prefix = sourceAliasPrefix(orgId, source.sourceId);
      const mine = existing.filter((entry) => entry.org === orgId && entry.name.startsWith(prefix));
      const names = new Set(wanted.map((model) => model.model_name));
      // The alias carries the org, so another org cannot own one of these names; a deployment that does is a collision LiteLLM would load-balance across.
      if (existing.some((entry) => names.has(entry.name) && entry.org !== orgId)) throw agentXError("CONFIG_INVALID", "a model with this alias already exists");
      const refuse = (reply: Reply): AgentXError => refusal(reply, key);
      const others = existing.filter((entry) => entry.org === orgId && entry.served && !entry.name.startsWith(prefix)).map((entry) => entry.name);
      // A Bedrock source is served only once its probe has passed (`tested`), and an endpoint only once a check qualified these exact settings; until then its models
      // exist for the probe but no team has them.
      const gated = (source.kind === "bedrock" && !source.tested) || (source.kind === "endpoint" && !endpointQualified(source));
      // S5: settings that are not served (a changed address or secret, say) leave the team BEFORE any deployment changes, so the alias never reaches a new, unapproved host
      // between the deployment and the team update. A served source keeps its alias throughout: new deployments first, then the old ones go.
      if (gated) await this.setTeamModels(master, orgId, others, catalog, key);
      if (key !== undefined) {
        const credential = { credential_name: credentialName, credential_values: { api_key: key, ...(source.kind === "endpoint" ? { api_base: source.baseUrl } : {}) }, credential_info: { rovara_org: orgId, rovara_source: source.sourceId } };
        const written = stored
          ? await this.request("PATCH", `/credentials/${encodeURIComponent(credentialName)}`, master, credential)
          : await this.request("POST", "/credentials", master, credential);
        if (written.status !== 200) throw refuse(written);
      }
      // New deployments first, then the old ones go: the alias never stops serving. The old ids are the ones listed above.
      const created = await Promise.all(wanted.map((model) => this.request("POST", "/model/new", master, { ...model })));
      for (const reply of created) if (reply.status !== 200) throw refuse(reply);
      await this.deleteModels(master, mine.map((entry) => entry.id), key);
      if (source.kind === "endpoint" && key === undefined && stored) {
        const dropped = await this.request("DELETE", `/credentials/${encodeURIComponent(credentialName)}`, master, undefined);
        if (dropped.status !== 200 && dropped.status !== 404) throw refuse(dropped);
      }
      if (!gated) await this.setTeamModels(master, orgId, [...others, ...names], catalog, key);
    } catch (error) {
      throw scrubbed(error, key);
    }
  }

  /** Reads an endpoint's secret through the function's reader. A reader that is missing, a secret that cannot be read, or a value that is not a plausible key is a fixed refusal with no detail. */
  private async readReferencedSecret(reference: string): Promise<string> {
    const resolve = this.input.resolveSecret;
    if (resolve === undefined) throw agentXError("CONFIG_INVALID", "secret references are not set up on this install");
    let value: string;
    try {
      value = await resolve(reference);
    } catch (error) {
      if (error instanceof AgentXError) throw error;
      throw unavailable("the endpoint's secret could not be read just now");
    }
    // The same shape as a vendor key: printable ASCII with no space. A value that is not one (a JSON document, an empty string) is not sent anywhere.
    if (!/^[\x21-\x7e]{8,4096}$/.test(value)) throw agentXError("CONFIG_INVALID", "the endpoint's secret is empty or not a plain key");
    return value;
  }

  async removeSource(orgId: OrgId, sourceId: string): Promise<void> {
    const catalog = this.teamCatalog();
    const master = await this.master();
    const existing = await this.listModels(master);
    const prefix = sourceAliasPrefix(orgId, sourceId);
    const mine = existing.filter((entry) => entry.org === orgId && entry.name.startsWith(prefix));
    // The team first: it takes the aliases away at once on every replica, while a deleted model lingers on a replica for up to about 30 seconds.
    await this.setTeamModels(master, orgId, existing.filter((entry) => entry.org === orgId && entry.served && !entry.name.startsWith(prefix)).map((entry) => entry.name), catalog);
    await this.deleteModels(master, mine.map((entry) => entry.id));
    const removed = await this.request("DELETE", `/credentials/${encodeURIComponent(credentialNameOf(orgId, sourceId))}`, master, undefined);
    // A source with no key (Bedrock) has no credential to remove.
    if (removed.status !== 200 && removed.status !== 404) throw refusal(removed);
  }

  async listSources(): Promise<Array<{ orgId: OrgId; sourceId: string; hosts?: string[] }>> {
    const master = await this.master();
    const found = new Map<string, { orgId: OrgId; sourceId: string; hosts: Set<string> }>();
    const note = (name: unknown, host: string | undefined): void => {
      // Both a model alias and a credential are named `<orgId>.<sourceId>` first.
      const match = typeof name === "string" ? /^(org_[0-9a-z]{20})\.(src_[0-9a-z]{20})(?:\.|$)/u.exec(name) : null;
      if (match === null) return;
      const key = `${match[1]!}/${match[2]!}`;
      const entry = found.get(key) ?? { orgId: match[1] as OrgId, sourceId: match[2]!, hosts: new Set<string>() };
      if (host !== undefined) entry.hosts.add(host);
      found.set(key, entry);
    };
    for (const entry of await this.listModels(master)) if (entry.org !== undefined) note(entry.name, entry.host);
    const credentials = await this.request("GET", "/credentials", master, undefined);
    if (credentials.status !== 200) throw refusal(credentials);
    const listed = isRecord(credentials.body) && Array.isArray(credentials.body.credentials) ? credentials.body.credentials : [];
    // Only the host of a credential's `api_base` is read; its key is never looked at.
    for (const entry of listed) if (isRecord(entry)) note(entry.credential_name, hostnameOf(isRecord(entry.credential_values) ? entry.credential_values.api_base : undefined));
    return [...found.values()].map(({ orgId, sourceId, hosts }) => ({ orgId, sourceId, ...(hosts.size === 0 ? {} : { hosts: [...hosts].sort() }) }));
  }

  async checkEndpoint(url: string): Promise<void> {
    if (this.input.checkEndpointHost === undefined) throw agentXError("CONFIG_INVALID", "custom model endpoints are not set up on this install");
    await this.input.checkEndpointHost(url);
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
      // The refusal's own words are not repeated: a health answer can quote the request it made.
      if (reply.status !== 200) throw agentXError(reply.status === 404 ? "NOT_FOUND" : "CONFIG_INVALID", `model proxy refused the health check (${String(reply.status)})`);
      const body = isRecord(reply.body) ? reply.body : {};
      // Never the body: an unhealthy entry carries the request, with a partly masked key.
      if ((numberOf(body.unhealthy_count) ?? 0) > 0) return { ok: false, message: "this source did not answer a test call" };
      if ((numberOf(body.healthy_count) ?? 0) > 0) healthy += 1;
    }
    const health = healthy === replies.length ? "healthy" : "unknown";
    // N2: a company endpoint is also asked for one tiny reply per model, and a reply that carries no token usage is refused: it would be priced at nothing.
    if (health === "healthy") {
      for (const entry of mine) {
        if (entry.kind !== "endpoint") continue;
        const refused = await this.probeUsage(master, entry);
        if (refused !== undefined) return { ok: false, message: refused };
      }
    }
    return { ok: true, health };
  }

  /** One small call through the proxy to an endpoint model; the message to show when it did not answer, or answered without token usage. */
  private async probeUsage(master: string, entry: ProxyModelEntry): Promise<string | undefined> {
    const prompt = "Reply with the single word: ok";
    let reply: Reply;
    try {
      reply = entry.api === "anthropic-messages"
        ? await this.request("POST", "/v1/messages", master, { model: entry.name, max_tokens: 16, messages: [{ role: "user", content: prompt }] })
        : entry.api === "openai-responses"
          ? await this.request("POST", "/v1/responses", master, { model: entry.name, input: prompt, max_output_tokens: 16 })
          : await this.request("POST", "/chat/completions", master, { model: entry.name, messages: [{ role: "user", content: prompt }], max_tokens: 16 });
    } catch (error) {
      // The proxy answered the health call a moment ago: a failure now is the endpoint's, not the proxy's.
      if (error instanceof AgentXError && error.code === "MODEL_PROXY_UNAVAILABLE") return "this source did not answer a test call";
      throw error;
    }
    if (reply.status !== 200) return "this source did not answer a test call";
    const usage = isRecord(reply.body) && isRecord(reply.body.usage) ? reply.body.usage : {};
    const total = numberOf(usage.total_tokens) ?? ((numberOf(usage.prompt_tokens) ?? numberOf(usage.input_tokens) ?? 0) + (numberOf(usage.completion_tokens) ?? numberOf(usage.output_tokens) ?? 0));
    if (total <= 0) return "this endpoint's replies carry no token usage, so its spend could not be counted";
    return this.probeStreamedUsage(master, entry);
  }

  /**
   * N2: the same small call, streamed. Usage is asked for where the format has the option (OpenAI chat), and the events are read for any usage report; a stream that ends
   * without one is refused, since the spend of a streamed reply would otherwise be counted as nothing.
   */
  private async probeStreamedUsage(master: string, entry: ProxyModelEntry): Promise<string | undefined> {
    const prompt = "Reply with the single word: ok";
    const [path, body]: [string, Json] = entry.api === "anthropic-messages"
      ? ["/v1/messages", { model: entry.name, max_tokens: 16, stream: true, messages: [{ role: "user", content: prompt }] }]
      : entry.api === "openai-responses"
        ? ["/v1/responses", { model: entry.name, input: prompt, max_output_tokens: 16, stream: true }]
        : ["/chat/completions", { model: entry.name, messages: [{ role: "user", content: prompt }], max_tokens: 16, stream: true, stream_options: { include_usage: true } }];
    let text: string;
    try {
      text = await this.requestText("POST", path, master, body);
    } catch (error) {
      if (error instanceof AgentXError && error.code === "MODEL_PROXY_UNAVAILABLE") return "this source did not answer a test call";
      throw error;
    }
    return streamedUsageTotal(text) > 0 ? undefined : "this endpoint's streamed replies carry no token usage, so its spend could not be counted";
  }

  /** One HTTP exchange whose answer is text (an event stream). A status that is not 200 is "did not answer"; redirects are not followed. */
  private async requestText(method: "POST", path: string, master: string, body: Json): Promise<string> {
    let response: Response;
    try {
      response = await this.input.fetch(`${this.baseUrl}${path}`, {
        method, headers: { authorization: `Bearer ${master}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual",
        signal: AbortSignal.timeout(this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw unavailable("model proxy is unreachable");
    }
    if (response.status !== 200) throw unavailable("model proxy did not answer the test call");
    try {
      return (await response.text()).slice(0, 262_144);
    } catch {
      throw unavailable("model proxy answer could not be read");
    }
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

  private async setTeamModels(master: string, orgId: OrgId, aliases: readonly string[], catalog: readonly string[], secret?: string): Promise<void> {
    const reply = await this.request("POST", "/team/update", master, { team_id: orgId, models: [...new Set([...aliases, ...catalog])] });
    if (reply.status !== 200) throw refusal(reply, secret);
  }

  private async deleteModels(master: string, ids: readonly string[], secret?: string): Promise<void> {
    const replies = await Promise.all(ids.map((id) => this.request("POST", "/model/delete", master, { id })));
    for (const reply of replies) if (reply.status !== 200 && reply.status !== 404) throw refusal(reply, secret);
  }

  private async credentialExists(master: string, name: string, secret?: string): Promise<boolean> {
    const reply = await this.request("GET", "/credentials", master, undefined);
    if (reply.status !== 200) throw refusal(reply, secret);
    const credentials = isRecord(reply.body) && Array.isArray(reply.body.credentials) ? reply.body.credentials : [];
    return credentials.some((entry) => isRecord(entry) && entry.credential_name === name);
  }

  /** Every model the proxy holds, reduced to what the registry needs. The listing carries no key; nothing else is kept. */
  private async listModels(master: string, secret?: string): Promise<ProxyModelEntry[]> {
    const reply = await this.request("GET", "/model/info", master, undefined);
    if (reply.status !== 200) throw refusal(reply, secret);
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
        kind: typeof info.rovara_kind === "string" ? info.rovara_kind : undefined,
        api: typeof info.rovara_api === "string" ? info.rovara_api : undefined,
        // A Bedrock model is served only once its probe has passed, and an endpoint's once a check qualified it; a missing flag fails closed. A deployment with an address
        // of its own (an endpoint) counts as one even when it predates the `rovara_kind` flag, so an older deployment is never read as served.
        served: (typeof info.rovara_role_arn !== "string" && info.rovara_kind !== "endpoint" && hostnameOf(isRecord(item.litellm_params) ? item.litellm_params.api_base : undefined) === undefined) || info.rovara_tested === true,
        host: hostnameOf(isRecord(item.litellm_params) ? item.litellm_params.api_base : undefined),
      });
    }
    return entries;
  }

  /** Creates the record; when the proxy says it already exists, the record is updated instead. Any other refusal is the create's own. */
  private async createOrUpdate(master: string, createPath: string, updatePath: string, createBody: Json, updateBody: Json = createBody): Promise<void> {
    const created = await this.request("POST", createPath, master, createBody);
    if (created.status === 200) return;
    // LiteLLM answers 400 for validation errors too, so only a 409 or an "already exists" 400 means the record is there.
    const exists = created.status === 409 || (created.status === 400 && /already exists/iu.test(proxyMessage(created.body)));
    if (!exists) throw refusal(created);
    const updated = await this.request("POST", updatePath, master, updateBody);
    if (updated.status !== 200) throw refusal(updated);
  }

  private async master(): Promise<string> {
    try {
      return await this.input.masterKey();
    } catch {
      throw unavailable("the model proxy master key could not be read");
    }
  }

  /** One HTTP exchange. Network failures and 5xx answers throw MODEL_PROXY_UNAVAILABLE; everything else is returned. */
  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, master: string, body: Json | undefined, timeoutMs?: number): Promise<Reply> {
    let response: Response;
    try {
      response = await this.input.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${master}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // N6: a redirect is never followed. The calls that reach a company's endpoint (the health call, the test replies) go through this one function; an answer that is a
        // redirect is refused, so no request, and nothing in it, is sent on to an address nobody approved.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs ?? this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw unavailable("model proxy is unreachable");
    }
    if (response.status >= 300 && response.status < 400) throw unavailable("model proxy answered with a redirect, which is not followed");
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
