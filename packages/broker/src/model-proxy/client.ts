// Broker client for the LiteLLM model proxy (docs/learnings/model-proxy-spike.md). A LiteLLM team is
// an org (team_id = orgId), a LiteLLM user is a developer (user_id = developerId), and a task or turn
// runs on a short-lived virtual key scoped to both. Caps reset on the 1st of each month, UTC
// (budget_duration "1mo"). It holds the master key only through the `masterKey` callback, reads it
// once per call, and never puts it, or a key, in an error. Network failures and 5xx answers are
// MODEL_PROXY_UNAVAILABLE; a 4xx carries the proxy's message.
import { agentXError, type AgentXError, type OrgId } from "@agentx/contracts";
import type { MemberSpend, MintKeyInput, MintedKey, ModelAccess, SpendFigures } from "./access.js";

const BUDGET_DURATION = "1mo";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 300;
const KEY_INFO_AT_ONCE = 10;

export interface ModelProxyClientInput {
  baseUrl: string;
  masterKey: () => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}

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
    const body = { user_id: developerId, max_budget: monthlyBudgetUsd, budget_duration: BUDGET_DURATION, metadata: { orgId } };
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
        // A key the proxy no longer has reports no spend; the others' figures stand.
        if (reply.status === 404) continue;
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
    const reply = await this.call("POST", "/key/generate", {
      team_id: input.orgId,
      ...(input.developerId === undefined ? {} : { user_id: input.developerId }),
      max_budget: input.maxBudgetUsd,
      duration: `${String(input.ttlSeconds)}s`,
      metadata: { orgId: input.orgId, ...(input.developerId === undefined ? {} : { developerId: input.developerId }), purpose: input.purpose, refId: input.refId },
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
  private async request(method: "GET" | "POST", path: string, master: string, body: Json | undefined): Promise<Reply> {
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
