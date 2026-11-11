// Owner decision 2026-11-03: Rovara picks only models the customer's account can actually call. Staging's Bedrock agreement for opus-5-5, fable-5-1, sonnet-5-5 and haiku-5-5 is NOT_AVAILABLE, so those calls are refused
// with 403 "<model> is not available for this account". Each rule below has a fixture where ONLY sonnet-4-6 is usable.
import { describe, expect, it } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalModelName, type ModelIdentifier } from "@rovara-code/contracts";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { foundationModelIdOf } from "@agentx/model-runtime/model-discovery";
import { FAILURE_TTL_MS, MODEL_USABILITY_KEY, PROBE_MAX_AGE_MS, PROBE_TTL_MS, availabilityDenied, createUsableModels, withoutUnusable, type AvailabilityProbe } from "../../packages/broker/src/model-sources/usable-models.js";
import { learnModelNotEnabled, modelsNotEnabled } from "../../packages/broker/src/model-sources/learn-not-enabled.js";
import { servableModels } from "../../packages/broker/src/model-sources/routing.js";
import { readStageModelEvidence } from "../../packages/broker/src/model-selection/evidence.js";
import { resolveStageModel } from "../../packages/broker/src/model-selection/resolver.js";
import { criticModelFor, criticModelUnusable } from "../../packages/broker/src/rovara-code/critic.js";
import { modelCallView } from "../../packages/broker/src/developer/model-call-view.js";
import { describeModelCallNote, modelFailureNextAction, sanitizeModelCallEvent } from "../../packages/worker/src/model-call-monitor.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { secondReviewModelUnusable } from "@rovara-code/contracts";
import { DEFAULT_AGENT_GUARDRAILS, editionFromEnvironment, modelNotEnabledSentence } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";

const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const bedrock = (id: string): ModelIdentifier => ({ provider: "amazon-bedrock", modelId: `us.anthropic.${id}` });
const CATALOG = bedrockClaudeModelIds("us").map((modelId): ModelIdentifier => ({ provider: "amazon-bedrock", modelId }));
const SONNET_46 = bedrock("claude-sonnet-4-6");
const ONLY = canonicalModelName(SONNET_46);

/** A one-item DynamoDB stand-in: reads the record, and applies the `SET #a = :a, ...` updates the module writes. */
function fakeTable(initial: Record<string, unknown> = {}) {
  const item: Record<string, unknown> = { ...initial };
  let reads = 0;
  let writes = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        expect(command.input.Key).toEqual(MODEL_USABILITY_KEY);
        reads += 1;
        return { Item: Object.keys(item).length === 0 ? undefined : { ...item } };
      }
      if (command instanceof UpdateCommand) {
        expect(command.input.Key).toEqual(MODEL_USABILITY_KEY);
        writes += 1;
        const names = command.input.ExpressionAttributeNames as Record<string, string>;
        const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
        for (const part of String(command.input.UpdateExpression).replace(/^SET /, "").split(", ")) {
          const [name, value] = part.split(" = ") as [string, string];
          item[names[name]!] = values[value];
        }
        return {};
      }
      throw new Error("unexpected command");
    },
  };
  return { client, item, counts: () => ({ reads, writes }) };
}

/** An account that has enabled sonnet-4-6 only: Bedrock reports every other foundation model's agreement as NOT_AVAILABLE. */
const onlySonnetProbe = (calls: string[] = []): AvailabilityProbe => async (foundationModelId) => {
  calls.push(foundationModelId);
  return foundationModelId === foundationModelIdOf(SONNET_46.modelId) ? { agreement: "AVAILABLE", authorization: "AUTHORIZED" } : { agreement: "NOT_AVAILABLE", authorization: "AUTHORIZED" };
};

const usable = (table: ReturnType<typeof fakeTable>, now: () => number, probe: AvailabilityProbe | null = onlySonnetProbe()) =>
  createUsableModels({ documentClient: table.client, tableName: "t", now, geography: "us", probe: probe ?? undefined });

describe("the usable-model check", () => {
  it("reads agreement and authorization: only a model whose agreement is not AVAILABLE, or that is not AUTHORIZED, is denied; unreadable (null) is not a denial", () => {
    expect(availabilityDenied({ agreement: "AVAILABLE", authorization: "AUTHORIZED" })).toBe(false);
    expect(availabilityDenied({ agreement: "NOT_AVAILABLE", authorization: "AUTHORIZED" })).toBe(true);
    expect(availabilityDenied({ agreement: "AVAILABLE", authorization: "NOT_AUTHORIZED" })).toBe(true);
    expect(availabilityDenied({ agreement: null, authorization: null })).toBe(false);
  });

  it("with only sonnet-4-6 enabled, every other catalog model is unusable; the probe asks once for each foundation model and keeps the answer for the TTL", async () => {
    const table = fakeTable();
    const calls: string[] = [];
    let now = 1_000_000;
    const models = usable(table, () => now, onlySonnetProbe(calls));
    const unusable = await models.unusable();
    expect([...unusable].sort()).toEqual(CATALOG.map(canonicalModelName).filter((name) => name !== ONLY).sort());
    expect(unusable.has(ONLY)).toBe(false);
    const asked = calls.length;
    expect(asked).toBeGreaterThan(5);
    expect(new Set(calls).size).toBe(asked);
    now += PROBE_TTL_MS - 1;
    expect((await models.unusable()).size).toBe(unusable.size);
    expect(calls.length).toBe(asked);
    now += 2;
    await models.unusable();
    expect(calls.length).toBe(asked * 2);
  });

  it("is single flight: while one request probes, the others do not probe and do not wait for it; they go on with the record they read", async () => {
    const table = fakeTable();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const slow: AvailabilityProbe = async (foundationModelId) => { calls.push(foundationModelId); await gate; return onlySonnetProbe()(foundationModelId); };
    const models = usable(table, () => 1_000_000, slow);
    const first = models.unusable();
    // The others return while the probe is still held, with nothing learned yet.
    const others = await Promise.all([models.unusable(), models.unusable()]);
    expect(others.map((set) => set.size)).toEqual([0, 0]);
    const asked = calls.length;
    expect(asked).toBeGreaterThan(5);
    release();
    expect((await first).size).toBe(CATALOG.length - 1);
    expect(calls.length).toBe(asked);
    // Done: the next request reads the saved answer and does not probe, and a probe due later starts a new flight.
    expect((await models.unusable()).size).toBe(CATALOG.length - 1);
    expect(calls.length).toBe(asked);
  });

  it("a probe that cannot run (no permission, unreachable) leaves every model usable and is not retried until the TTL", async () => {
    const table = fakeTable();
    let calls = 0;
    const models = usable(table, () => 5_000_000, async () => { calls += 1; throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); });
    expect((await models.unusable()).size).toBe(0);
    const first = calls;
    expect((await models.unusable()).size).toBe(0);
    expect(calls).toBe(first);
  });

  it("an old probe answer is not trusted once the probe has failed for a day, and a record that cannot be read teaches nothing", async () => {
    const stale = fakeTable({ probedAt: 1, probeOkAt: 1, [`probe#${canonicalModelName(CATALOG[0]!)}`]: "no" });
    expect((await usable(stale, () => 1 + PROBE_MAX_AGE_MS + 1, null).unusable()).size).toBe(0);
    expect((await usable(stale, () => 1 + PROBE_MAX_AGE_MS - 1, null).unusable()).size).toBe(1);
    const broken = createUsableModels({ documentClient: { send: async () => { throw new Error("down"); } }, tableName: "t", now: () => 1, geography: "us" });
    expect((await broken.unusable()).size).toBe(0);
  });

  it("learns from a refused call: the model is unusable for FAILURE_TTL even when the probe says it is available, then comes back", async () => {
    const table = fakeTable();
    let now = 10_000_000;
    const everyoneAvailable: AvailabilityProbe = async () => ({ agreement: "AVAILABLE", authorization: "AUTHORIZED" });
    const models = usable(table, () => now, everyoneAvailable);
    expect((await models.unusable()).size).toBe(0);
    await models.markUnusable(SONNET_46);
    expect([...(await models.unusable())]).toEqual([ONLY]);
    now += FAILURE_TTL_MS - 1;
    expect((await models.unusable()).has(ONLY)).toBe(true);
    now += 2;
    expect((await models.unusable()).has(ONLY)).toBe(false);
  });

  it("learns only Rovara's catalog models (a model it does not serve writes nothing)", async () => {
    const table = fakeTable();
    const models = usable(table, () => 1, null);
    await models.markUnusable({ provider: "openai", modelId: "gpt-5" });
    expect(table.counts().writes).toBe(0);
  });

  it("never narrows a list to nothing", () => {
    const all = new Set(CATALOG.map(canonicalModelName));
    expect(withoutUnusable(CATALOG, all)).toEqual(CATALOG);
    expect(withoutUnusable(CATALOG, new Set([ONLY])).map(canonicalModelName)).not.toContain(ONLY);
  });
});

describe("servableModels and the plan check, with only sonnet-4-6 usable", () => {
  it("lists only sonnet-4-6 from Rovara's catalog, where it listed all of it before", async () => {
    const table = fakeTable();
    const models = usable(table, () => 1);
    expect(await servableModels({}, org)).toHaveLength(CATALOG.length);
    expect(await servableModels({ usableModels: models }, org)).toEqual([SONNET_46]);
    const store = { read: async () => ({ sources: [], order: ["rovara"], credentials: [], removing: [], revision: 2 }) };
    expect(await servableModels({ sources: store, usableModels: models }, org, "web")).toEqual([SONNET_46]);
  });

  it("the plan check goes straight to sonnet-4-6; without the check it would start with a model the account cannot call", async () => {
    const models = usable(fakeTable(), () => 1);
    const limits = { step: undefined, agentName: "Rovara Code", planModel: bedrock("claude-opus-4-7"), project: { name: "web" }, guardrails: DEFAULT_AGENT_GUARDRAILS };
    const filtered = criticModelFor({ ...limits, sources: await servableModels({ usableModels: models }, org) });
    expect(filtered).toMatchObject({ model: { provider: "amazon-bedrock", modelId: SONNET_46.modelId } });
    const unfiltered = criticModelFor({ ...limits, sources: await servableModels({}, org) });
    expect(unfiltered).not.toMatchObject({ model: { modelId: SONNET_46.modelId } });
  });
});

describe("the review default, with only sonnet-4-6 usable", () => {
  const stored = { sources: [], order: ["rovara"], credentials: [], removing: [], revision: 2 };
  const reference = bedrock("claude-opus-4-7");
  const decide = async (flagged: boolean, more: Record<string, unknown> = {}) => {
    const evidence = await readStageModelEvidence({ routing: { sources: { read: async () => stored }, ...(flagged ? { usableModels: usable(fakeTable(), () => 1) } : {}) }, now: () => 0 }, { orgId: org, project: "web", models: CATALOG.filter((model) => canonicalModelName(model) !== canonicalModelName(reference)) });
    return { evidence, result: resolveStageModel({ orgId: org, stage: "code_review", sourcesRevision: 2, candidates: evidence.candidates, forbidden: [], referenceModel: reference, builtinDefault: reference, allowLegacyDefaultFallback: true, reviewDefaultDifferentCompany: true, ...more }) };
  };

  it("marks the catalog models the account cannot call, and only those", async () => {
    const { evidence } = await decide(true);
    const marked = evidence.candidates.filter((candidate) => candidate.accountCannotUse === true).map((candidate) => canonicalModelName(candidate.model));
    expect(marked.sort()).toEqual(CATALOG.map(canonicalModelName).filter((name) => name !== ONLY && name !== canonicalModelName(reference)).sort());
    expect((await decide(false)).evidence.candidates.some((candidate) => candidate.accountCannotUse === true)).toBe(false);
  });

  it("picks sonnet-4-6, and records why: the default model it would have taken was not usable", async () => {
    const wanted = (await decide(false)).result;
    expect(wanted).toMatchObject({ kind: "resolved" });
    const { result } = await decide(true);
    expect(result).toMatchObject({ kind: "resolved", model: SONNET_46, fallback: { stage: "code_review", used: `amazon-bedrock/${SONNET_46.modelId}`, reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
    if (wanted.kind !== "resolved" || result.kind !== "resolved") throw new Error("fixture");
    expect(canonicalModelName(wanted.model)).not.toBe(ONLY);
    expect(result.fallback?.wanted).toBe(`${wanted.model.provider}/${wanted.model.modelId}`);
  });

  it("never refuses what was accepted before: with every candidate unusable the choice is made as it was", async () => {
    const flaggedAll = (await decide(false)).evidence.candidates.map((candidate) => ({ ...candidate, accountCannotUse: true as const }));
    const base = (await decide(false)).result;
    const result = resolveStageModel({ orgId: org, stage: "code_review", sourcesRevision: 2, candidates: flaggedAll, forbidden: [], referenceModel: reference, builtinDefault: reference, allowLegacyDefaultFallback: true, reviewDefaultDifferentCompany: true });
    expect(result).toEqual(base);
  });

  it("never overrides a model somebody chose: an explicit choice of an unusable model stands, a configured fallback is used when it is usable", async () => {
    const opus55 = bedrock("claude-opus-5-5");
    const explicit = await decide(true, { projectChoice: { model: opus55 } });
    expect(explicit.result).toMatchObject({ kind: "resolved", model: opus55, reason: "PROJECT_CHOICE" });
    const withFallback = await decide(true, { projectChoice: { model: opus55, fallbackModel: SONNET_46 } });
    expect(withFallback.result).toMatchObject({ kind: "resolved", model: SONNET_46, fallback: { reasonCode: "CONFIGURED_FALLBACK" } });
  });
});

describe("the refused call: a clear class and a safe message", () => {
  const forced403 = (model = "us.anthropic.claude-opus-5-5", errorMessage = `403 {"error":{"type":"permission_error","message":"${model} is not available for this account"}}`) =>
    ({ type: "message_end", message: { role: "assistant", provider: "amazon-bedrock", model, stopReason: "error", errorMessage, content: [] } });
  const note = () => {
    const found = sanitizeModelCallEvent(forced403())?.modelCall;
    if (found?.outcome !== "failed") throw new Error("fixture");
    return found;
  };

  it("classes the proxy's 403 as a refused key told apart by ModelNotEnabled, with the model's name, where it was unknown before", () => {
    expect(note()).toMatchObject({ class: "key-rejected", signal: "ModelNotEnabled", status: 403, provider: "amazon-bedrock", model: "claude-opus-5-5" });
    expect(describeModelCallNote(note())).toBe("the model call failed: key-rejected ModelNotEnabled HTTP 403 attempt 1");
  });

  it("tells the owner what to do, in fixed words", () => {
    const sentence = "claude-opus-5-5 isn't enabled for your AWS account. Enable it in the Bedrock console, or Rovara will use another model.";
    expect(modelFailureNextAction(note(), "enterprise")).toBe(sentence);
    expect(modelCallView({ modelCall: note() }, "enterprise")).toEqual({ kind: "error", text: sentence });
    const error = failedTurn({ stopReason: "error", errorMessage: "x" }, { note: note() });
    // No edition in this process's environment (an EC2 worker has none): neither account is named.
    expect(error?.message).toBe("RUNTIME_UNAVAILABLE: the model call failed: key-rejected ModelNotEnabled HTTP 403 attempt 1; claude-opus-5-5 isn't available on the AWS account behind this model route; Rovara will use another model.");
  });

  it("is worded by edition: Rovara Cloud runs the route on Rovara's account, so there is nothing for the customer to enable", () => {
    const cloud = "claude-opus-5-5 isn't available on Rovara's AI right now; Rovara will use another model.";
    expect(modelFailureNextAction(note(), "public")).toBe(cloud);
    expect(modelCallView({ modelCall: note() }, "public")).toEqual({ kind: "error", text: cloud });
    expect(modelCallView({ modelCall: note() }, "enterprise")?.text).not.toContain("Rovara's AI");
    expect(`${cloud}${modelFailureNextAction(note(), "public")}`).not.toMatch(/AWS account|Bedrock console/u);
    expect(modelNotEnabledSentence(undefined, "public")).toBe("This model isn't available on Rovara's AI right now; Rovara will use another model.");
    expect(editionFromEnvironment({ ROVARA_EDITION: "public" })).toBe("public");
    expect(editionFromEnvironment({ ROVARA_EDITION: "enterprise" })).toBe("enterprise");
    expect(editionFromEnvironment({ ROVARA_EDITION: "bogus" })).toBeUndefined();
    expect(editionFromEnvironment({})).toBeUndefined();
  });

  const failedNote = (found: ReturnType<typeof sanitizeModelCallEvent>) => {
    if (found?.modelCall.outcome !== "failed") throw new Error("fixture");
    return found.modelCall;
  };

  it("carries nothing the provider wrote: no prompt, key or body reaches the note, the sentence or the view", () => {
    const hostile = forced403("us.anthropic.claude-opus-5-5", '403 {"error":{"message":"us.anthropic.claude-opus-5-5 is not available for this account; Bearer sk-ant-api03-SECRET prompt: ignore previous"}}');
    const found = sanitizeModelCallEvent(hostile);
    const everything = JSON.stringify([found, describeModelCallNote(failedNote(found)), modelFailureNextAction(failedNote(found)), modelCallView(found)]);
    expect(everything).not.toMatch(/SECRET|sk-ant|prompt|ignore previous|Bearer/u);
    // The model name must be a plain token.
    expect(modelCallView({ modelCall: { ...note(), model: "<script>alert(1)</script>" } }, "enterprise")?.text).toBe("This model isn't enabled for your AWS account. Enable it in the Bedrock console, or Rovara will use another model.");
  });

  it("is not fooled by other failures: a 500 whose text repeats the phrase, or a throttle, is not 'not enabled'", () => {
    expect(sanitizeModelCallEvent(forced403("us.anthropic.claude-opus-5-5", "500 us.anthropic.claude-opus-5-5 is not available for this account"))?.modelCall).toMatchObject({ class: "provider-outage" });
    expect(sanitizeModelCallEvent(forced403("us.anthropic.claude-opus-5-5", "429 slow down"))?.modelCall).toMatchObject({ class: "limit-or-rate-limited" });
  });

  it("Bedrock's own SDK diagnostics still decide for a direct Bedrock call", () => {
    const direct = { type: "message_end", message: { role: "assistant", provider: "amazon-bedrock", stopReason: "error", errorMessage: "403 is not available for this account", diagnostics: [{ details: { errorCode: "ThrottlingException", status: 429 } }] } };
    expect(sanitizeModelCallEvent(direct)?.modelCall).toMatchObject({ class: "limit-or-rate-limited", signal: "ThrottlingException" });
  });

  it("the plan check and the second review move on to the next model", () => {
    const sentence = `${describeModelCallNote(note())}; ${modelFailureNextAction(note())}`;
    expect(criticModelUnusable(sentence)).toBe(true);
    expect(secondReviewModelUnusable({ modelFailure: describeModelCallNote(note()) })).toBe(true);
    // An unclassified failure (the proxy's 403 read this way before) is unusable for a second review too; a request the provider refused is not.
    expect(secondReviewModelUnusable({ modelFailure: "the model call failed: unknown attempt 1" })).toBe(true);
    expect(secondReviewModelUnusable({ modelFailure: "the model call failed: request-rejected attempt 1" })).toBe(false);
    expect(secondReviewModelUnusable({ modelFailure: "the model call failed: provider-outage attempt 1" })).toBe(false);
  });
});

describe("learning from a finished operation", () => {
  const failure = "the model call failed: key-rejected ModelNotEnabled HTTP 403 attempt 1; claude-opus-5-5 isn't enabled for your AWS account. Enable it in the Bedrock console, or Rovara will use another model.";
  const opus55 = bedrock("claude-opus-5-5");

  it("a failed operation on Rovara's route marks the model it ran on", () => {
    expect(modelsNotEnabled({ model: opus55 }, "FAILED", failure, undefined)).toEqual([opus55]);
    expect(modelsNotEnabled({ model: opus55, modelRoute: { sourceId: "rovara" } }, "FAILED", failure, undefined)).toEqual([opus55]);
  });
  it("a company's own source is another account: nothing is learned from it; nor from another failure or a success", () => {
    expect(modelsNotEnabled({ model: opus55, modelRoute: { sourceId: "src_abcdefghijklmnopqrst" } }, "FAILED", failure, undefined)).toEqual([]);
    expect(modelsNotEnabled({ model: opus55 }, "FAILED", "the model call failed: key-rejected AccessDeniedException HTTP 403 attempt 1", undefined)).toEqual([]);
    expect(modelsNotEnabled({ model: opus55 }, "SUCCEEDED", failure, undefined)).toEqual([]);
  });
  it("a review that succeeded with a reviewer whose own model call was refused teaches that reviewer's model", () => {
    const result = { workflowReviews: [{ provider: "amazon-bedrock", version: "us.anthropic.claude-fable-5-1", modelFailure: "the model call failed: key-rejected ModelNotEnabled HTTP 403 attempt 1" }, { provider: "amazon-bedrock", version: SONNET_46.modelId }] };
    expect(modelsNotEnabled({ model: SONNET_46 }, "SUCCEEDED", undefined, result)).toEqual([{ provider: "amazon-bedrock", modelId: "us.anthropic.claude-fable-5-1" }]);
  });
  it("the next default choice leaves the model out, for any task", async () => {
    const table = fakeTable();
    const models = usable(table, () => 1, null);
    await learnModelNotEnabled(models, { model: opus55 }, "FAILED", failure, undefined);
    expect((await servableModels({ usableModels: models }, org)).map(canonicalModelName)).not.toContain(canonicalModelName(opus55));
    expect(await servableModels({ usableModels: models }, org)).toHaveLength(CATALOG.length - 1);
  });
});
