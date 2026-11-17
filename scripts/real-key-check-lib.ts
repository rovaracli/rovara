// The pure parts of the owner's real-key check (DEC 254t a). scripts/real-key-check.ts is the ONLY place that reads a real key or
// builds a real transport; tests import this file with fake transports and never touch the network.
//
// One check = ONE agent call through the gateway's OWN money core (handleGateway) on the kind's own path: the same guard, admission,
// transport, secret scanner, usage reader, price resolver and settleAmount the agent route uses. Only the task token, the meter, the
// budget, the ended-task list and the company's stored choice and key are in-memory stand-ins. The price source is empty on purpose,
// so the check also proves the gateway never settles an unknown price at $0 (DEC 172/216: a cautious estimate, flagged estimated).
//
// Nothing here prints, logs, stores or returns a key: the result holds only fixed words and numbers, every failure path answers with
// fixed words, and the gateway's own scanner stops an answer that carries the key.
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentAiSource, ByoBedrock, CompanyChatAi } from "../packages/model-gateway/src/agent-ai.js";
import { OPENAI_AGENT_MODEL } from "../packages/model-gateway/src/agent-openai.js";
import type { AwsCredentials } from "../packages/model-gateway/src/aws.js";
import { allowedBedrockModel, BEDROCK_BYO_REGION } from "../packages/model-gateway/src/bedrock-byo.js";
import { BEDROCK_CLAUDE_ID } from "../packages/model-gateway/src/bedrock-transport.js";
import { FixedCapsSource } from "../packages/model-gateway/src/caps.js";
import { InMemoryEndedTasks } from "../packages/model-gateway/src/ended.js";
import type { LearningKeySource } from "../packages/model-gateway/src/learning-route.js";
import { InMemoryMeter, type EstimatedSettlement, type Reservation } from "../packages/model-gateway/src/meter.js";
import type { TaskClaims } from "../packages/model-gateway/src/model-gateway-token.js";
import { UnknownPriceSource } from "../packages/model-gateway/src/price.js";
import type { ProviderResponse, ProviderTransport } from "../packages/model-gateway/src/provider.js";
import { handleGateway, type GatewayDependencies, type GatewaySink } from "../packages/model-gateway/src/server.js";
import { UsageCollector, type TokenUsage } from "../packages/model-gateway/src/usage.js";

export const CHECK_KINDS = ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const;
export type CheckKind = typeof CHECK_KINDS[number];
/** The kinds whose transport exists in this build. The others answer "not built yet" before any key is read. */
export const CHECK_KINDS_BUILT: readonly CheckKind[] = ["anthropic", "bedrock", "openai", "openrouter"];
/** The consent switch: the check refuses without exactly this. */
export const CONSENT_VARIABLE = "ROVARA_REAL_KEY_CHECK";
/** Where a key may come from besides the hidden prompt. Never argv, a file or chat. */
export const KEY_VARIABLE: Readonly<Record<CheckKind, string | undefined>> = Object.freeze({
  anthropic: "ROVARA_CHECK_ANTHROPIC_KEY", openai: "ROVARA_CHECK_OPENAI_KEY", openrouter: "ROVARA_CHECK_OPENROUTER_KEY", bedrock: undefined, endpoint: "ROVARA_CHECK_ENDPOINT_KEY",
});
/** What the one call asks for: a forced call of one tool, in at most this many output tokens. */
export const CHECK_MAX_TOKENS = 64;
/** The gateway's own guard refuses any request above this (the check's model limit), so no request can ask for more. */
export const CHECK_TOKEN_CEILING = 256;
/** The whole check stops after this long (the gateway's own deadline is shorter for 64 tokens anyway). */
export const CHECK_TIMEOUT_MS = 90_000;
export const CHECK_TOOL = Object.freeze({ name: "ping", description: "Answer the check. Call it with no arguments.", input_schema: { type: "object", properties: {} } });
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5-mini";
export const DEFAULT_BEDROCK_AGENT_MODEL = "claude-haiku-4-5";
export const DEFAULT_BEDROCK_MODEL_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
/** The staging guard's profile (staging-aws.sh): the Bedrock check is the owner's OWN account, never Rovara's staging account. */
export const STAGING_PROFILE = "agentx-test";
const AGENT_MODEL = /^claude-[a-z0-9-]{1,80}$/u;
const MIN_KEY = 6;
const MAX_KEY = 8192;

/** Fixed words for every way a check can stop early. Nothing in them comes from input, a provider or an error. */
export const WORDS = Object.freeze({
  usage: "usage: real-key-check.ts <anthropic|openai|openrouter|bedrock|endpoint>",
  consent: `refused: set ${"ROVARA_REAL_KEY_CHECK"}=1 (this makes ONE real, billed provider call with your own key)`,
  notBuilt: "refused: this kind's agent route is not built in this branch yet",
  noKey: "refused: no key given (set the kind's environment variable, or run in a terminal to be asked without echo)",
  badKey: "refused: the key is empty, too long or has a line break",
  badModel: "refused: the model setting is not one this check accepts",
  badRegion: "refused: ROVARA_CHECK_BEDROCK_REGION must be a Bedrock Region such as us-west-2",
  stagingProfile: "refused: the Bedrock check uses YOUR OWN AWS account; do not run it through staging-aws.sh or the agentx-test profile",
  noCredentials: "refused: could not read AWS credentials from the AWS CLI (aws configure export-credentials)",
  stopped: "FAIL: the check stopped before it finished (details withheld so no key can leak)",
});

export interface CheckLine { name: string; ok: boolean; detail?: string }
export interface CheckResult { lines: CheckLine[]; pass: boolean }

/** The one request: Anthropic Messages, as Code's engine sends it, with one tool the model must call. */
export function checkRequest(model: string): Record<string, unknown> {
  return {
    model, max_tokens: CHECK_MAX_TOKENS, stream: true,
    tools: [CHECK_TOOL], tool_choice: { type: "tool", name: CHECK_TOOL.name },
    messages: [{ role: "user", content: "This is a connection check. Call the ping tool." }],
  };
}

/** What the agent saw: whether the stream ended, a tool call came back in the agent's (Anthropic) shape, and the stop reason. */
export interface StreamFacts { complete: boolean; toolCall: boolean; stopReason?: string; usage?: TokenUsage }
/** Reads the SSE the gateway wrote to the agent. Text is never kept; only the facts above. Anything malformed is "not complete". */
export function readAgentStream(bytes: Buffer): StreamFacts {
  const usage = new UsageCollector();
  usage.push(bytes);
  const counts = usage.finish();
  let complete = false; let toolCall = false; let stopReason: string | undefined;
  try {
    for (const block of bytes.toString("utf8").split(/\r?\n\r?\n/u)) {
      const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data === "") continue;
      const event = JSON.parse(data) as { type?: unknown; content_block?: { type?: unknown; name?: unknown }; delta?: { stop_reason?: unknown } };
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && event.content_block.name === CHECK_TOOL.name) toolCall = true;
      if (event.type === "message_delta" && typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
      if (event.type === "message_stop") complete = true;
    }
  } catch { return { complete: false, toolCall: false }; }
  return { complete, toolCall, ...(stopReason === undefined ? {} : { stopReason }), ...(counts === undefined ? {} : { usage: counts }) };
}

/** The settled amount, as the meter received it from the gateway's money core. */
export interface Settled { micros: number; estimated: boolean; usage?: TokenUsage }

class RecordingMeter extends InMemoryMeter {
  settled: Settled | undefined;
  override async settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement): Promise<void> {
    this.settled = { micros: actualMicros, estimated: estimated !== undefined, ...(estimated?.usage === undefined ? {} : { usage: estimated.usage }) };
    return super.settle(reservation, actualMicros, estimated);
  }
}

class CollectingSink implements GatewaySink {
  status = 0; ended = false; destroyed = false; bytes: Buffer[] = []; total = 0;
  head(status: number): void { this.status = status; }
  async write(chunk: Uint8Array): Promise<void> {
    // The check's own bound on what it keeps (the gateway bounds the answer too).
    this.total += chunk.byteLength;
    if (this.total <= 1024 * 1024) this.bytes.push(Buffer.from(chunk));
  }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }
}

/** How a check reaches the provider: the kind's agent source and what that source needs. Built by the entry script (real) or a test (fake). */
export type CheckTarget =
  | { kind: "anthropic" | "openai" | "openrouter"; key: string; model: string; transport: ProviderTransport }
  | { kind: "bedrock"; region: string; agentModel: string; bedrockModel: string; credentials: AwsCredentials; transport: (region: string, credentials: () => Promise<AwsCredentials>) => ProviderTransport };

const COMPANY = `org_${"c".repeat(20)}`;
const ISSUER = "https://real-key-check.invalid/v1/auth";

/** The stored company choice and key, in memory: exactly what the agent route reads for that source. */
function sourceFor(target: CheckTarget): { source: AgentAiSource; keys: LearningKeySource; byo?: ByoBedrock; chat?: CompanyChatAi; model: string } {
  if (target.kind !== "bedrock") {
    const key = target.key; const provider = target.kind;
    const source: AgentAiSource = provider === "anthropic" ? "anthropic_key" : provider === "openai" ? "openai_key" : "openrouter_key";
    return {
      source, model: target.model,
      keys: { connected: async (_iss, cid, asked) => cid === COMPANY && asked === provider, keyFor: async (_iss, cid, asked) => cid === COMPANY && asked === provider ? key : undefined },
      ...(provider === "anthropic" ? {} : { chat: { transport: target.transport } }),
    };
  }
  const row = { iss: ISSUER, cid: COMPANY, owner: "company", sourceId: "real-key-check", versionId: "1" };
  const connection = { scheme: "assume_role" as const, roleArn: "arn:aws:iam::000000000000:role/RovaraBedrockInvoke-check", region: target.region, models: { [target.agentModel]: target.bedrockModel }, allowGlobal: false };
  const credentials = target.credentials;
  return {
    source: "bedrock_byo", model: target.agentModel,
    // The agent route reads no key for Bedrock; it never asks this.
    keys: { connected: async () => false, keyFor: async () => undefined },
    byo: {
      connection: async (iss, cid) => iss === ISSUER && cid === COMPANY ? { row, connection } : undefined,
      // The owner's own credentials stand in for the assumed role's session (the role and its trust are the settings page's connection test).
      sessions: { credentials: async () => ({ ok: true as const, credentials }), forget: () => undefined },
      transport: target.transport,
    },
  };
}

/**
 * Runs the one call and judges it. Never throws, never returns key material: any failure is a fixed line. `transport` and the key
 * come from the caller; nothing else leaves the process.
 */
export async function runCheck(target: CheckTarget, now: () => number = Date.now): Promise<CheckResult> {
  try {
    const { source, keys, byo, chat, model } = sourceFor(target);
    // OpenRouter's reported cost, as the transport handed it to the money core (read after the call).
    let reported: (() => number | undefined) | undefined;
    const watched = chat === undefined ? undefined : { ...chat, transport: async (request: Parameters<ProviderTransport>[0]): Promise<ProviderResponse> => { const response = await chat.transport(request); reported = response.reportedCostMicros; return response; } };
    const token = `check-${randomBytes(24).toString("hex")}`;
    const at = Math.floor(now() / 1000);
    const claims: TaskClaims = { iss: ISSUER, aud: "rovara-model-gateway", jti: randomUUID(), iat: at, nbf: at - 30, exp: at + 900, cid: COMPANY, pid: "real-key-check", pay: { kind: "project", project: "real-key-check" }, tid: `check-${randomUUID()}`, ws: randomUUID(), op: randomUUID(), stp: "build", mdl: [model] };
    const meter = new RecordingMeter(now);
    const settledLog: Array<{ costMicros: number; estimated: boolean }> = [];
    const deps: GatewayDependencies = {
      verifyToken: async (value) => value === token ? claims : undefined,
      ended: new InMemoryEndedTasks(), meter, now,
      caps: new FixedCapsSource({ task: 5_000_000, personMonth: 5_000_000, projectMonth: 5_000_000, companyMonth: 5_000_000 }),
      // No price rows: the gateway's cautious estimate (never $0).
      prices: UnknownPriceSource,
      metrics: { overrunBusy: () => undefined },
      modelLimits: { maxOutputTokens: () => CHECK_TOKEN_CEILING },
      // Company-key mode: Rovara's install key is never read.
      keys: { keyFor: async () => { throw new Error("install key never read"); } },
      transport: target.kind === "anthropic" ? target.transport : async () => { throw new Error("not this route"); },
      agentKeys: keys,
      agentAi: {
        sources: { sourceFor: async (cid) => cid === COMPANY ? source : undefined }, ...(byo === undefined ? {} : { byo }),
        // The check is the owner's own, before the switch: this one kind is on for it.
        switchedOn: new Set([target.kind]),
        ...(watched === undefined ? {} : target.kind === "openai" ? { openai: watched } : { openrouter: watched }),
      },
      timeoutMs: CHECK_TIMEOUT_MS,
      log: (event) => { if (event.event === "settled") settledLog.push({ costMicros: event.costMicros, estimated: event.estimated }); },
    };
    const sink = new CollectingSink();
    const body = Buffer.from(JSON.stringify(checkRequest(model)));
    await handleGateway(deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield body; })() }, sink);
    let reportedMicros: number | undefined;
    try { reportedMicros = reported?.(); } catch { reportedMicros = undefined; }
    return judge(target.kind, sink, meter.settled, reportedMicros);
  } catch {
    return { lines: [{ name: "check ran", ok: false, detail: WORDS.stopped }], pass: false };
  }
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;
const REFUSAL_CODE = /^[a-z_]{1,40}$/u;

/** Judges one finished call from what the agent saw (`sink`), what the meter settled and OpenRouter's reported cost. Exported for tests. */
export function judge(kind: CheckKind, sink: Pick<CollectingSink, "status" | "ended" | "destroyed" | "bytes">, settled: Settled | undefined, reported: number | undefined): CheckResult {
  const bytes = Buffer.concat(sink.bytes);
  const lines: CheckLine[] = [];
  const httpOk = sink.status === 200;
  let refusal: string | undefined;
  if (!httpOk) {
    // The gateway's own fixed refusal code (never provider text, never echoed input): safe to show.
    try { const code = (JSON.parse(bytes.toString("utf8")) as { error?: { type?: unknown } }).error?.type; if (typeof code === "string" && REFUSAL_CODE.test(code)) refusal = code; } catch { /* no code shown */ }
  }
  lines.push({ name: "HTTP ok", ok: httpOk, ...(httpOk ? {} : { detail: `gateway answered ${String(sink.status)}${refusal === undefined ? "" : ` ${refusal}`}` }) });
  const facts = httpOk ? readAgentStream(bytes) : { complete: false, toolCall: false };
  lines.push({ name: "answer streamed to completion", ok: httpOk && sink.ended && !sink.destroyed && facts.complete });
  lines.push({ name: "a tool call came back in the agent's (Anthropic) shape", ok: facts.toolCall && facts.stopReason === "tool_use", ...(facts.stopReason === undefined ? {} : { detail: `stop reason ${REFUSAL_CODE.test(facts.stopReason) ? facts.stopReason : "other"}` }) });
  const usage = facts.usage;
  const usageOk = usage !== undefined && usage.input > 0 && usage.output > 0;
  lines.push({ name: "usage read", ok: usageOk, ...(usage === undefined ? {} : { detail: `${String(usage.input)} input, ${String(usage.output)} output, ${String(usage.cacheRead)} cache read, ${String(usage.cacheWrite)} cache write tokens` }) });
  lines.push({ name: "settled above $0", ok: settled !== undefined && settled.micros > 0, ...(settled === undefined ? {} : { detail: usd(settled.micros) }) });
  if (kind === "openrouter") {
    // OpenRouter reports the call's cost; with no price row, settleAmount uses it as the actual amount (not an estimate).
    lines.push({ name: "OpenRouter reported cost read", ok: reported !== undefined && reported > 0, ...(reported === undefined ? {} : { detail: usd(reported) }) });
    lines.push({ name: "unknown price settled at the reported cost (settleAmount's rule), never $0", ok: settled !== undefined && reported !== undefined && settled.micros === reported && !settled.estimated });
  } else {
    // No price rows in the check: the settle must be the cautious estimate, flagged estimated (so a correction row is written), never $0.
    lines.push({ name: "unknown price settled as a flagged estimate, never $0", ok: settled !== undefined && settled.micros > 0 && settled.estimated && settled.usage !== undefined });
  }
  return { lines, pass: lines.every((line) => line.ok) };
}

/** One line per check, then PASS or FAIL. Fixed words and numbers only. */
export function formatResult(kind: CheckKind, result: CheckResult): string[] {
  return [...result.lines.map((line) => `${line.ok ? "ok  " : "FAIL"} ${line.name}${line.detail === undefined ? "" : ` (${line.detail})`}`), `${result.pass ? "PASS" : "FAIL"} real-key check: ${kind}`];
}

/** The kind named on the command line: exactly one argument, one of CHECK_KINDS. Anything else (a key pasted as an argument, say) is the usage line, never echoed. */
export function parseKind(argv: readonly string[]): CheckKind | undefined {
  if (argv.length !== 1) return undefined;
  return CHECK_KINDS.find((kind) => kind === argv[0]);
}

export function keyProblem(key: string): string | undefined {
  return key.length < MIN_KEY || key.length > MAX_KEY || /[\r\n\0]/u.test(key) ? WORDS.badKey : undefined;
}

/** The OpenAI or OpenRouter model to call: ROVARA_CHECK_OPENAI_MODEL / ROVARA_CHECK_OPENROUTER_MODEL or the cheap default. */
export function chatModel(kind: "openai" | "openrouter", env: Readonly<Record<string, string | undefined>>): string | undefined {
  const model = (kind === "openai" ? env.ROVARA_CHECK_OPENAI_MODEL : env.ROVARA_CHECK_OPENROUTER_MODEL) ?? (kind === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_OPENROUTER_MODEL);
  return OPENAI_AGENT_MODEL.test(model) ? model : undefined;
}

/** The Anthropic model to call: ROVARA_CHECK_ANTHROPIC_MODEL or the cheap default. */
export function anthropicModel(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const model = env.ROVARA_CHECK_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  return AGENT_MODEL.test(model) ? model : undefined;
}

/** The Bedrock settings: the Region (required), the Claude id or profile (default Haiku 4.5's US profile in a US Region), the agent's name for it. */
export function bedrockSettings(env: Readonly<Record<string, string | undefined>>): { region: string; bedrockModel: string; agentModel: string } | string {
  if (env.AWS_PROFILE === STAGING_PROFILE) return WORDS.stagingProfile;
  const region = env.ROVARA_CHECK_BEDROCK_REGION;
  if (region === undefined || !BEDROCK_BYO_REGION.test(region)) return WORDS.badRegion;
  const bedrockModel = env.ROVARA_CHECK_BEDROCK_MODEL ?? (region.startsWith("us-") ? DEFAULT_BEDROCK_MODEL_US : "");
  const agentModel = env.ROVARA_CHECK_BEDROCK_AGENT_MODEL ?? DEFAULT_BEDROCK_AGENT_MODEL;
  if (!BEDROCK_CLAUDE_ID.test(bedrockModel) || !allowedBedrockModel(bedrockModel, region, false) || !AGENT_MODEL.test(agentModel)) return WORDS.badModel;
  return { region, bedrockModel, agentModel };
}

/** The `aws configure export-credentials --format process` answer, kept in memory only. Undefined when it is not that shape. */
export function parseCliCredentials(text: string): AwsCredentials | undefined {
  try {
    const raw = JSON.parse(text) as { Version?: unknown; AccessKeyId?: unknown; SecretAccessKey?: unknown; SessionToken?: unknown };
    if (typeof raw.AccessKeyId !== "string" || !/^[A-Z0-9]{16,128}$/u.test(raw.AccessKeyId) || typeof raw.SecretAccessKey !== "string" || raw.SecretAccessKey.length < 16) return undefined;
    if (raw.SessionToken !== undefined && typeof raw.SessionToken !== "string") return undefined;
    return { accessKeyId: raw.AccessKeyId, secretAccessKey: raw.SecretAccessKey, ...(typeof raw.SessionToken === "string" ? { sessionToken: raw.SessionToken } : {}) };
  } catch { return undefined; }
}

/** What the hidden prompt needs from a terminal: raw mode (no echo), its data, and a place for the prompt words. */
export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown; pause(): unknown;
}
/**
 * Asks for the key without echo: raw mode, nothing typed is written back, Enter ends, Ctrl-C or Ctrl-D cancel (undefined).
 * Not a terminal: undefined (the key is never read from a pipe or a file).
 */
export function promptHidden(input: HiddenInput, write: (text: string) => void, label: string): Promise<string | undefined> {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let typed = "";
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return; done = true;
      input.off("data", onData);
      try { input.setRawMode?.(false); } catch { /* the terminal is left as it was */ }
      input.pause();
      write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") { finish(typed); return; }
        if (char === "\u0003" || char === "\u0004") { finish(undefined); return; }
        if (char === "\u007f" || char === "\b") { typed = typed.slice(0, -1); continue; }
        if (typed.length > MAX_KEY) { finish(undefined); return; }
        typed += char;
      }
    };
    write(`${label} (input hidden, Enter to finish): `);
    input.setRawMode!(true);
    input.on("data", onData);
    input.resume();
  });
}
