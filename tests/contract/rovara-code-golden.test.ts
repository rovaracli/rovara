import {developerIdForSlackUser} from "../../packages/broker/src/aws/admin-actions.js";
import {TEST_ORG} from "../support/orgs.js";
import {SLACK_TEAM,SLACK_CHANNEL} from "../support/slack-broker.js";
// Task 1 of the agents plan: what an unchanged Rovara Code does, recorded before anything changes. Each scenario below
// is recorded by tests/support/golden-recorder.ts and compared with its fixture in tests/fixtures/rovara-code-golden.
// Fixtures are written only with UPDATE_GOLDEN=1, and SHA256SUMS (made with `shasum -a 256`) pins them: a later task never
// re-records, and a change it means to make is listed in `deliberate` with the plan's item number.
import { createHash } from "node:crypto";
import type * as NodeCrypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS, builtinDefaultPin, builtinRecipe } from "@rovara-code/contracts";
import { recipeDigest } from "@rovara-code/contracts";
import { STAGE_OPERATION_MAPPING, TaskModelPolicyBindingSchema } from "@rovara-code/contracts";
import { GOLDEN_FIXTURE_DIRECTORY, GOLDEN_SCENARIOS, GOLDEN_THREAD_MODELS, expectGolden, recordGolden, updatingGolden, type GoldenScenario } from "../support/golden-recorder.js";
import { loadSlackBroker } from "../support/slack-broker.js";

// Every id the broker and the worker make comes from randomUUID; the recorder seeds a sequence per scenario.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const { goldenUuid } = await import("../support/golden-ids.js");
  return { ...actual, randomUUID: goldenUuid, default: { ...actual, randomUUID: goldenUuid } };
});

// The hash of SHA256SUMS itself, so the list of fixture hashes cannot be edited in the same breath as a fixture. A change
// to this value is a re-record: it needs the per-path attribution and the Opus review that PF4 requires of a Plan 2 merge.
// Re-record 2026-11-07 (UX2 slice 2 item 1, the one status model), per path: plan-ready-full.json and plan-ready-quick.json change ONLY the shared thread's start line, "Status: STARTING." to
// "Status: Planning." (the Slack start message says the status in words, never the raw code). No other fixture changed.
// Re-record 2026-11-08 (0.5.11, feat/lessons-capture: the record of which pull request comments the agent was shown), per path: feedback-review.json gains ONLY
// `taskItems[0].workflow.feedbackShown` = { rounds: [{ at: "2026-10-20T00:00:00.000Z", pulls: [] }] } (the one collection round of the scenario, whose bundles carry no comments). The field was
// added by hand at that path, not by UPDATE_GOLDEN=1, so the change 1/4/7 deltas stay deliberate. No other fixture changed.
const SHA256SUMS_SHA256 = "214d32f2817f15ca041772e333932230c8c700fd89883e0643771979e13590c8";

beforeAll(async () => { await loadSlackBroker(); });

// Plan 3 Task 34, change 1: a workflow task starts at its planning limit ($2 Quick, $6 Full) and a task with no workflow at the TASK estimate's run limit ($10
// with no history), instead of the $25 per-task cap; approving a coding plan sets the run limit its estimate gave ($6 Quick with no history) and starts the
// window at what planning spent. Change 4: a coding plan that reaches review carries that estimate (`task.runEstimate`), and the plan-ready message says it, with the raise
// (0.5.11, QA6-12b: 'This raises the run limit from $2 to $6', which Slack's Approve confirms).
const NO_HISTORY_ESTIMATE = { basis: "default", highUsd: 3, lowUsd: 1, runLimitUsd: 6, samples: 0, stopAtUsd: 6 };
const READY_WITH_ESTIMATE = "*Coding plan v1 is ready for your approval.* No code has changed yet.\n> Payments that fail with a timeout are retried.\n> A payment is never charged twice.\nAnd 1 more claim.\nThis raises the run limit from $2 to $6. Approving accepts $6 as the run limit, or asks for it if your role cannot.\nApprove here uses AgentX's answers for 1 decision and includes the open comments (up to 25) from the task page.\n• d1: How many times should a payment be retried? Answer: Three times\n• Not checked by AgentX's plan check.\nNo automated checks apply. Review only.\nEstimated cost: about $1\u2013$3. Run limit: $6.\nI couldn't link the full coding plan; ask an AgentX admin to check the task page.";
/** The limit each scenario's task has when the scenario is recorded; `baseline` and `estimate` are fields the task gains by then, `readyText` the post that gains the estimate line. */
const RUN_LIMITS: Partial<Record<GoldenScenario, { budgetUsd: number; baseline?: true; estimate?: true; readyText?: true }>> = {
  "plan-quick": { budgetUsd: 2 },
  "plan-full-requirements": { budgetUsd: 6 },
  "plan-full-design": { budgetUsd: 6 },
  "plan-full-implementation-plan": { budgetUsd: 6 },
  "plan-review-decision": { budgetUsd: 2, estimate: true },
  implement: { budgetUsd: 6, baseline: true, estimate: true },
  checks: { budgetUsd: 6, estimate: true },
  review: { budgetUsd: 6, baseline: true, estimate: true },
  "feedback-review": { budgetUsd: 2 },
  "task-no-workflow": { budgetUsd: 10 },
  "shared-task": { budgetUsd: 10 },
  "plan-ready-quick": { budgetUsd: 2, estimate: true, readyText: true },
  "plan-ready-full": { budgetUsd: 6 },
};
function nodePaths(record: unknown, matches: (node: Record<string, unknown>) => boolean, path = ""): string[] {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found = !Array.isArray(record) && matches(here) ? [path] : [];
  for (const [key, child] of Object.entries(here)) found.push(...nodePaths(child, matches, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
function stringPaths(record: unknown, matches: (text: string) => boolean, path = ""): string[] {
  if (typeof record === "string") return matches(record) ? [path] : [];
  if (record === null || typeof record !== "object") return [];
  return Object.entries(record).flatMap(([key, child]) => stringPaths(child, matches, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
}
/** Every string in a record with the path it is at. */
function stringsAt(record: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof record === "string") return [{ path, text: record }];
  if (record === null || typeof record !== "object") return [];
  return Object.entries(record).flatMap(([key, child]) => stringsAt(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
}
/**
 * 0.5.11 (QA6-12b): the plan-ready post's Approve button says the new limit and carries it ("Approve coding plan and raise the limit to $6", `runLimitUsd` in its value), in the post and in its notice. The value
 * is the old one plus that amount; it is checked as such, then taken by value like the other deliberate changes.
 */
function approveButtonChanges(record: unknown, readyText: boolean): Array<{ path: string; expected: unknown; change: 4 }> {
  if (!readyText) return [];
  const label = `Approve coding plan and raise the limit to $${String(NO_HISTORY_ESTIMATE.runLimitUsd)}`;
  const labels = stringsAt(record).filter((entry) => entry.text === label).map((entry) => ({ path: entry.path, expected: label, change: 4 as const }));
  const values = stringsAt(record).filter((entry) => entry.text.startsWith('{"taskId"') && entry.text.includes('"decision":"APPROVE"')).map((entry) => {
    expect(JSON.parse(entry.text), "the Approve button carries the limit it shows").toMatchObject({ decision: "APPROVE", runLimitUsd: NO_HISTORY_ESTIMATE.runLimitUsd });
    return { path: entry.path, expected: entry.text, change: 4 as const };
  });
  expect(labels.length, "the Approve button's label, in the post and its blocks").toBeGreaterThan(0);
  expect(values.length, "the Approve button's value, in the post and its blocks").toBeGreaterThan(0);
  return [...labels, ...values];
}
/** The deliberate changes of change 1 and change 4 in one record, each by value. */
function runLimitChanges(scenario: GoldenScenario, record: unknown): Array<{ path: string; expected: unknown; change: 1 | 4 }> {
  const limit = RUN_LIMITS[scenario];
  if (limit === undefined) return [];
  const mints = nodePaths(record, (node) => "purpose" in node && "refId" in node && "maxBudgetUsd" in node);
  if (scenario === "checks") expect(mints, "model-free CHECKS never mints a key").toHaveLength(0);
  else expect(mints, `${scenario} shows the keys it minted`).not.toHaveLength(0);
  const items = (record as { taskItems: Array<{ entityType?: string }> }).taskItems;
  const task = items.findIndex((item) => item.entityType === "DEVELOPER_TASK");
  expect(task, `${scenario} shows its task`).toBeGreaterThanOrEqual(0);
  const ready = limit.readyText === true ? stringPaths(record, (text) => text.includes("Coding plan v1 is ready for your approval.")) : [];
  if (limit.readyText === true) expect(ready, `${scenario} says the plan is ready in its post, its blocks and its notice`).toHaveLength(3);
  return [
    ...mints.map((path) => ({ path: `${path}.maxBudgetUsd`, expected: limit.budgetUsd, change: 1 as const })),
    { path: `taskItems[${String(task)}].budgetUsd`, expected: limit.budgetUsd, change: 1 as const },
    ...(limit.baseline === true ? [{ path: `taskItems[${String(task)}].budgetBaselineUsd`, expected: 0, change: 1 as const }] : []),
    ...(limit.estimate === true ? [{ path: `taskItems[${String(task)}].runEstimate`, expected: NO_HISTORY_ESTIMATE, change: 4 as const }] : []),
    ...ready.map((path) => ({ path, expected: READY_WITH_ESTIMATE, change: 4 as const })),
    ...approveButtonChanges(record, limit.readyText === true),
  ];
}


/**
 * Round 4 merge (mainline M1.3 Task 3.7b and M1.4): a capability that allows `candidate-export` now also allows `candidate-build-source` and `baseline-source` (the same
 * grant, for the candidate's build source and the baseline's source). Every capability in the record is checked against the fixture's: the same claims, with those two actions
 * added after `candidate-export`, nothing else; then it is listed by value.
 */
function capabilityPaths(record: unknown, path = ""): string[] {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: string[] = [];
  if (!Array.isArray(record) && typeof here.callbackCapability === "string") found.push(path === "" ? "callbackCapability" : `${path}.callbackCapability`);
  for (const [key, child] of Object.entries(here)) found.push(...capabilityPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
const valueAt = (record: unknown, path: string): unknown => path.split(/\.|(?=\[)/u).filter(Boolean).reduce<unknown>((node, part) => {
  const index = /^\[(\d+)\]$/u.exec(part);
  return (node as Record<string, unknown>)[index === null ? part : index[1]!];
}, record);
const claimsOfCapability = (capability: string) => JSON.parse(Buffer.from(capability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] } & Record<string, unknown>;
function capabilityChanges(scenario: GoldenScenario, record: unknown): Array<{ path: string; expected: unknown; change: 6 }> {
  const stored = JSON.parse(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, `${scenario}.json`), "utf8")) as unknown;
  return capabilityPaths(record).flatMap((path) => {
    const now = valueAt(record, path);
    const before = valueAt(stored, path);
    if (typeof now !== "string" || typeof before !== "string" || now === before) return [];
    const claims = claimsOfCapability(now);
    const wasClaims = claimsOfCapability(before);
    const grown = wasClaims.actions.flatMap((action) => (action === "candidate-export" ? [action, "candidate-build-source", "baseline-source"] : [action]));
    const parentPath = path.slice(0, -".callbackCapability".length);
    const parent = valueAt(record, parentPath) as { payload?: Record<string, unknown> };
    const modelFree = parent.payload?.workflowMode === "CHECKS";
    const actions = modelFree ? grown.filter(action => action !== "model-access") : grown;
    const policy = parent.payload?.modelPolicy;
    const expected = policy === undefined ? undefined : expectedModelPolicy(parent.payload!);
    expect({ ...claims, actions: claims.actions }, `${scenario} ${path}: only candidate-source and bound C53 fallback grants grew`).toEqual({ ...wasClaims, actions: expected === undefined ? actions : actions.flatMap(action => action === "result" ? [action, "model-fallback"] : [action]), ...(expected === undefined ? {} : { modelPolicy: expected }) });
    return [{ path, expected: now, change: 6 as const }];
  });
}

/** C53 change 7: exact frozen policy/stage bindings, never a wildcard capability allowance. */
function expectedModelPolicy(node: Record<string, unknown>) {
  const mode = (node.workflowMode ?? "IMPLEMENT") as keyof typeof STAGE_OPERATION_MAPPING;
  const stage = STAGE_OPERATION_MAPPING[mode]?.stages[0];
  expect(stage, "only model-using governed modes carry a policy binding").toBeDefined();
  const expected = { version: 1, stage, companyRevision: 0, recipeDigest: recipeDigest(builtinRecipe("rovara-code", builtinDefaultPin("rovara-code"))) };
  expect(TaskModelPolicyBindingSchema.parse(node.modelPolicy)).toEqual(expected);
  return expected;
}
/** Change 7 (review defaults): a review operation that could only reach the builder's own company's models records `reviewNoOtherCompany: true`; listed by value where it appears. */
function reviewNoOtherCompanyChanges(record: unknown): Array<{ path: string; expected: unknown; change: 7 }> {
  return nodePaths(record, node => node.reviewNoOtherCompany === true).map(path => ({ path: path === "" ? "reviewNoOtherCompany" : `${path}.reviewNoOtherCompany`, expected: true, change: 7 as const }));
}
function modelPolicyChanges(record: unknown): Array<{ path: string; expected: unknown; change: 7 }> {
  const tasks = (record as { taskItems: Array<Record<string, unknown>> }).taskItems;
  const taskId = tasks.find(item => item.sk === "META")?.taskId;
  expect(taskId).toEqual(expect.any(String));
  return [
    ...reviewNoOtherCompanyChanges(record),
    ...nodePaths(record, node => "modelPolicy" in node).map(path => ({ path: `${path}.modelPolicy`, expected: expectedModelPolicy(valueAt(record, path) as Record<string, unknown>), change: 7 as const })),
    ...nodePaths(record, node => "modelTaskId" in node).map(path => ({ path: `${path}.modelTaskId`, expected: taskId, change: 7 as const })),
    ...nodePaths(record, node => node.entityType === "OPERATION" && "modelPolicy" in node).map(path => ({ path: `${path}.model`, expected: { provider: "amazon-bedrock", modelId: (valueAt(record, path) as Record<string, unknown>).workflowMode === "REVIEW" ? "us.anthropic.claude-opus-5-5" : ROVARA_DEFAULT }, change: 7 as const })),
  ];
}

/** C53 policy/pin/model attribution; no-policy legacy key behavior remains compared unchanged. */
function ordinaryStageChanges(scenario:GoldenScenario,record:unknown):Array<{path:string;expected:unknown;change:7}> {
 const recipe=builtinRecipe("rovara-code",builtinDefaultPin("rovara-code")),digest=recipeDigest(recipe);
 const thread=scenario==="slack-thread-operation"||scenario==="chatgpt-task",actor=thread?developerIdForSlackUser("U0123456789"):"d".repeat(64);
 const model=scenario==="chatgpt-task"?{provider:"openai",modelId:"gpt-6.1-sol"}:{provider:"amazon-bedrock",modelId:scenario==="review"?"us.anthropic.claude-opus-5-5":ROVARA_DEFAULT};
 const policyNodes=nodePaths(record,node=>"modelPolicy" in node);
 if(scenario!=="checks"&&scenario!=="orchestrator-turn")expect(policyNodes.length,"each model-using scenario retains C53 governance").toBeGreaterThan(0);
 const changes=policyNodes.flatMap(path=>{
  const node=valueAt(record,path) as Record<string,unknown>;
  const fields:Array<{path:string;expected:unknown;change:7}>=[{path:`${path}.modelPolicy`,expected:expectedModelPolicy(node),change:7 as const},{path:`${path}.model`,expected:model,change:7 as const}];
  if(node.entityType==="OPERATION") {
   const mode=typeof node.workflowMode==="string"?node.workflowMode:"IMPLEMENT";
   fields.push({path:`${path}.modelTurnPin`,expected:{version:1,...(mode===undefined?{}:{workflowMode:mode}),actorDeveloperId:actor,payerDeveloperId:actor,agentId:"rovara-code",recipe,digest,...(thread?{slackUserId:"U0123456789",threadChannel:{teamId:SLACK_TEAM,channelId:SLACK_CHANNEL}}:{}),pin:{version:1,orgId:TEST_ORG,project:"payments",registeredAt:"2026-10-20T00:00:00.000Z",processAgentId:"rovara-code",recipeDigest:digest,policy:{version:1,revision:0,rankingVersion:"g3-v1",stepOverrides:{}},sourcesRevision:0,frozenInputs:{projectRevision:1,projectChoices:{},recipeDefaults:{},clearedFallbacks:[],reviewDefault:"different_company",...(thread?{projectModels:GOLDEN_THREAD_MODELS}:{})}}},change:7});
   if(scenario!=="task-no-workflow-no-proxy"&&scenario!=="chatgpt-task")fields.push({path:`${path}.modelRoute`,expected:{sourceId:"rovara",alias:model.modelId,model},change:7});
  }
  return fields;
 });
 if(scenario==="chatgpt-task")for(const path of nodePaths(record,node=>node.entityType==="OPERATION"&&"modelPolicy" in node))changes.push({path:`${path}.modelRoute`,expected:null,change:7});
 return [...changes, ...reviewNoOtherCompanyChanges(record)];
}

/**
 * Change 7 (mainline #408 sync, plan quality): a coding plan's planning run is asked for the plan quality members, so (a) its operation record says `planQualityAsked`, (b) its prompt gains the
 * "Plan quality guidance" block, wherever the prompt is recorded, and (c) the plan-ready card lists the answers Approve takes and what AgentX's plan check says of the plan ("Not checked" when it
 * did not run). Each is checked by value: without its block or its lines the record must equal the fixture's, and the changed path is then listed with its exact new value.
 */
const GUIDANCE_BLOCK = /Plan quality guidance:\n[\s\S]*?End of plan quality guidance\.\n\n/u;
const CARD_ADDED_LINES = /^\u2022 (?:d1: How many times should a payment be retried\? Answer: Three times|Not checked by AgentX's plan check\.)\n/gmu;
function planQualityChanges(scenario: GoldenScenario, record: unknown, skipCard: readonly string[]): Array<{ path: string; expected: unknown; change: 7 }> {
  const stored = JSON.parse(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, `${scenario}.json`), "utf8")) as unknown;
  const asked = nodePaths(record, (node) => node.planQualityAsked === true).map((path) => ({ path: path === "" ? "planQualityAsked" : `${path}.planQualityAsked`, expected: true, change: 7 as const }));
  const prompts = stringPaths(record, (text) => text.includes("Plan quality guidance:\n")).map((path) => {
    const now = valueAt(record, path) as string;
    expect(now.replace(GUIDANCE_BLOCK, ""), `${scenario} ${path}: only the plan quality guidance block was added`).toBe(valueAt(stored, path));
    return { path, expected: now, change: 7 as const };
  });
  const cards = stringPaths(record, (text) => text.includes("\u2022 d1: How many times should a payment be retried?")).filter((path) => !skipCard.includes(path)).map((path) => {
    const now = valueAt(record, path) as string;
    expect(`${now}\n`.replace(CARD_ADDED_LINES, "").replace(/\n$/u, ""), `${scenario} ${path}: only the answer and plan check lines were added`).toBe(valueAt(stored, path));
    return { path, expected: now, change: 7 as const };
  });
  return [...asked, ...prompts, ...cards];
}

function modelFreeChecksChanges(scenario: GoldenScenario, record: unknown): Array<{ path: string; expected: unknown; change: 7 }> {
  if (scenario !== "checks") return [];
  return nodePaths(record, node => "mintKeyCalls" in node && "response" in node && "status" in node).flatMap(path => {
    const access = valueAt(record, path) as { response: { requestId: string } };
    expect(access.response.requestId).toMatch(/^[a-f0-9-]{36}$/u);
    return [
      { path: `${path}.status`, expected: 401, change: 7 as const },
      { path: `${path}.response`, expected: { error: { code: "AUTH_REQUIRED", message: "invalid callback capability" }, requestId: access.response.requestId }, change: 7 as const },
      { path: `${path}.mintKeyCalls`, expected: [], change: 7 as const },
      { path: `${path}.calls.mintKey`, expected: [], change: 7 as const },
      { path: `${path}.calls.keySpend`, expected: [], change: 7 as const },
      { path: `${path}.calls.spend`, expected: [["org_5t5gp58cc1ibgg6e3aoj", "d".repeat(64)]], change: 7 as const },
    ];
  });
}

describe("Rovara Code before agents", () => {
  for (const scenario of GOLDEN_SCENARIOS) {
    it(`${scenario} matches its golden fixture, apart from change 1 and change 4`, async () => {
      const record = await recordGolden(scenario);
      expectGolden(scenario, record, updatingGolden() ? [] : [...ordinaryStageChanges(scenario,record), ...modelFreeChecksChanges(scenario, record), ...runLimitChanges(scenario, record), ...capabilityChanges(scenario, record), ...planQualityChanges(scenario, record, runLimitChanges(scenario, record).filter((change) => change.change === 4 && typeof change.expected === "string").map((change) => change.path))]);
    }, 120_000);
  }

  it("expectGolden accepts a changed path only when it is listed with its exact new value", () => {
    if (updatingGolden()) return;
    const stored = JSON.parse(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, "implement.json"), "utf8")) as { invocation: { payload: Record<string, unknown> }; modelAccess: { mintKeyCalls: Array<Record<string, unknown>> } };
    const changed = structuredClone(stored);
    changed.modelAccess.mintKeyCalls[0] = { ...changed.modelAccess.mintKeyCalls[0], maxBudgetUsd: 6, models: ["alias"] };
    const listed = [
      { path: "modelAccess.mintKeyCalls[0].maxBudgetUsd", expected: 6, change: 1 as const },
      { path: "modelAccess.mintKeyCalls[0].models", expected: ["alias"], change: 2 as const },
    ];
    expect(() => expectGolden("implement", stored)).not.toThrow();
    expect(() => expectGolden("implement", changed)).toThrow();
    expect(() => expectGolden("implement", changed, listed)).not.toThrow();
    expect(() => expectGolden("implement", changed, [{ ...listed[0]!, expected: 7 }, listed[1]!])).toThrow();
    expect(() => expectGolden("implement", changed, [listed[0]!])).toThrow();
    // A listed path that should be absent fails when the record has it, and an unlisted change elsewhere still fails.
    expect(() => expectGolden("implement", stored, [{ path: "invocation.payload.prompt", expected: undefined, change: 5 }])).toThrow();
    const other = structuredClone(stored);
    other.invocation.payload.prompt = "Something else";
    expect(() => expectGolden("implement", other, listed)).toThrow();
  });

  it("fixture files match the SHA-256 values committed in Task 1", () => {
    if (updatingGolden()) return;
    expect(createHash("sha256").update(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, "SHA256SUMS"))).digest("hex"), "SHA256SUMS").toBe(SHA256SUMS_SHA256);
    const sums = readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => {
      const [sha256, path] = line.split(/\s+/);
      return [basename(path ?? ""), sha256] as const;
    });
    const files = readdirSync(GOLDEN_FIXTURE_DIRECTORY).filter((name) => name.endsWith(".json")).sort();
    expect(sums.map(([name]) => name).sort()).toEqual(files);
    expect(files).toEqual(GOLDEN_SCENARIOS.map((scenario) => `${scenario}.json`).sort());
    for (const [name, sha256] of sums) {
      expect(createHash("sha256").update(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, name))).digest("hex"), name).toBe(sha256);
    }
  });
});

// Plan 3 Task 15: with the agents switched on, a start that names no agent runs Rovara Code at the org's pinned version and records it. The only
// differences from the fixtures are change 5's paths: the task's `agent`, `origin`, `payer`, `place` and `startedBy`, the `tags` of each model key minted, and the RECIPE item beside the task.
/** The paths of the `tags` on every model proxy key the record shows minting (a mint call has a `purpose` and a `refId`), with the tags. */
function mintTagPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && "purpose" in here && "refId" in here && "tags" in here) found.push({ path: `${path}.tags`, value: here.tags });
  for (const [key, child] of Object.entries(here)) found.push(...mintTagPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}

/**
 * Plan 3 Task 31: with agents set up a minted key is recorded on the operation as well as the task (change 3), so the operation as the record shows it ends with
 * the ids of its keys. Every operation in the record that has them, with the path of its `modelKeyIds`.
 */
function operationKeyPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && here.entityType === "OPERATION" && Array.isArray(here.modelKeyIds)) found.push({ path: `${path}.modelKeyIds`, value: here.modelKeyIds });
  for (const [key, child] of Object.entries(here)) found.push(...operationKeyPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}

/**
 * Plan 3 Task 26: with agents set up every key is scoped to the model its operation runs on (change 2: the key's `models`), and the operation records the route
 * it was built with (change 5: records gain fields). Rovara's default model is served by Rovara itself under its own catalog id, so the invocation carries no
 * `modelRoute`. The paths of the `models` on every key the record shows minting, and of the `modelRoute` on every operation that has one.
 */
function mintModelPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && "purpose" in here && "refId" in here && "tags" in here && "models" in here) found.push({ path: `${path}.models`, value: here.models });
  for (const [key, child] of Object.entries(here)) found.push(...mintModelPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
/** Change 2 again: the worker is told the model its key allows, so a task payload (it has a prompt and `conversationStarted`) now carries `model`. */
function payloadModelPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && "conversationStarted" in here && "prompt" in here && "model" in here) found.push({ path: `${path}.model`, value: here.model });
  for (const [key, child] of Object.entries(here)) found.push(...payloadModelPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
/** How many task payloads (a prompt and `conversationStarted`) the record shows. */
function taskPayloadCount(record: unknown): number {
  if (record === null || typeof record !== "object") return 0;
  const here = record as Record<string, unknown>;
  const own = !Array.isArray(record) && "conversationStarted" in here && "prompt" in here && here.workflowMode !== "CHECKS" ? 1 : 0;
  return own + Object.values(here).reduce<number>((total, child) => total + taskPayloadCount(child), 0);
}
function operationRoutePaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && here.entityType === "OPERATION" && "modelRoute" in here) found.push({ path: `${path}.modelRoute`, value: here.modelRoute });
  for (const [key, child] of Object.entries(here)) found.push(...operationRoutePaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
const ROVARA_DEFAULT = "us.anthropic.claude-sonnet-4-6";

describe("Rovara Code with agents switched on", () => {
  const STARTS: GoldenScenario[] = [
    "plan-quick", "plan-full-requirements", "plan-review-decision", "implement", "checks", "review", "task-no-workflow", "task-no-workflow-no-proxy", "shared-task", "plan-ready-quick",
  ];
  const latest = BUILTIN_AGENTS["rovara-code"].versions.find((v) => v.version === builtinDefaultPin("rovara-code"))!;

  for (const scenario of STARTS) {
    it(`${scenario} differs from its golden fixture only by the task's agent, origin, payer, place, session id, the keys' tags, the operation's key ids, the RECIPE item and change 1 and 4`, async () => {
      if (updatingGolden()) return;
      const record = await recordGolden(scenario, { brokerExtra: { agents: {} } });
      const items = record.taskItems as Array<Record<string, unknown>>;
      const recipe = items.filter((item) => item.sk === "RECIPE");
      expect(recipe).toHaveLength(1);
      expect(recipe[0]).toMatchObject({ digest: recipeDigest(latest.recipe), recipe: latest.recipe });
      const kept = items.filter((item) => item.sk !== "RECIPE");
      const meta = kept.findIndex((item) => item.sk === "META");
      // Plan 3 Task 29: the task records its payer and place, and every key minted for it carries the tags that say so (change 5: records gain fields).
      const payer = { kind: "member", developerId: (kept[meta] as { developerId: string }).developerId };
      const tagged = mintTagPaths(record);
      for (const { value } of tagged) {
        expect(value).toMatchObject({ agentId: "rovara-code", project: "payments", payerKind: "member", payerId: payer.developerId, source: "rovara", origin: "cli" });
      }
      // Every key that carries tags carries `models` too: a mint that lost its scope would match the fixture (which has none) and go unlisted otherwise.
      expect(mintModelPaths(record), "every minted key is scoped").toHaveLength(tagged.length);
      // Every task payload names the model its key allows: one that lost it would match the fixture (which has none) and go unlisted otherwise.
      // (The one scenario without a model proxy chooses no route.)
      if (scenario !== "task-no-workflow-no-proxy") expect(payloadModelPaths(record), "every task payload names its model").toHaveLength(taskPayloadCount(record));
      // Plan 5 Task 2: the start also writes the task's session, so the task carries its id (a random one: its shape is the check, and the record's own value is listed).
      const sessionId = (kept[meta] as { sessionId?: string }).sessionId;
      expect(sessionId, `${scenario}'s task names its session`).toMatch(/^ses_[0-9a-z]{20}$/);
      const recorded = { ...record, taskItems: kept };
      // The default reviewer must differ from the Sonnet builder. Fable, Opus, GPT-5 and Gemini Pro are one frontier tier (review defaults, 2878c376e); inside it the cheaper list price wins, so this pool selects Opus.
      const stageModel = scenario === "review" ? "us.anthropic.claude-opus-5-5" : ROVARA_DEFAULT;
      expectGolden(scenario, recorded, [
        ...modelFreeChecksChanges(scenario, recorded),
        ...runLimitChanges(scenario, recorded),
        ...capabilityChanges(scenario, recorded),
        ...modelPolicyChanges(recorded),
        ...planQualityChanges(scenario, recorded, runLimitChanges(scenario, recorded).filter((change) => change.change === 4 && typeof change.expected === "string").map((change) => change.path)),
        { path: `taskItems[${String(meta)}].sessionId`, expected: sessionId, change: 5 },
        { path: `taskItems[${String(meta)}].agent`, expected: { agentId: "rovara-code", name: "Rovara Code", version: latest.version, builtin: true, digest: recipeDigest(latest.recipe) }, change: 5 },
        { path: `taskItems[${String(meta)}].origin`, expected: "cli", change: 5 },
        { path: `taskItems[${String(meta)}].payer`, expected: payer, change: 5 },
        { path: `taskItems[${String(meta)}].place`, expected: { project: "payments" }, change: 5 },
        { path: `taskItems[${String(meta)}].startedBy`, expected: { developerId: payer.developerId }, change: 5 },
        ...tagged.map(({ path, value }) => ({ path, expected: value, change: 5 as const })),
        ...operationKeyPaths(record).map(({ path, value }) => ({ path, expected: value, change: 3 as const })),
        // Task 26, change 2: with the default order (Rovara only) a key may call Rovara's default model and nothing else, and it says so by value.
        ...mintModelPaths(record).map(({ path }) => ({ path, expected: [stageModel], change: 2 as const })),
        ...payloadModelPaths(record).map(({ path }) => ({ path, expected: { provider: "amazon-bedrock", modelId: stageModel }, change: 2 as const })),
        // Change 5: the operation says where its model comes from. The invocation is unchanged: it carries no `modelRoute`.
        ...operationRoutePaths(record).map(({ path }) => ({ path, expected: { sourceId: "rovara", alias: stageModel, model: { provider: "amazon-bedrock", modelId: stageModel } }, change: 5 as const })),
      ]);
      for (const sent of [record.invocation, record.forWorker] as Array<{ payload?: Record<string, unknown> } | null>) expect(sent?.payload ?? {}).not.toHaveProperty("modelRoute");
    }, 120_000);
  }
});

// Plan quality (2026-10-27), change 7: three graded rehearsals scored the plan and the implementation for the same gaps, so Rovara Code version 2's plan and build steps now carry general guidance
// (strict input rules, tests for a new option alone, combined and at the boundaries, and every CI check in the plan). That changes version 2's recipe, and so its digest, in exactly the two paths
// listed here, by value. Version 1 is not touched: its digest, its fixtures and SHA256SUMS above are byte-identical, and the golden fixtures record version 1.
const V2_DIGEST_BEFORE = "1b47c1f54341f67bf8c6d8292b42079ef756dc0c52f1c2710d7b1f2ffb9e3aea";
const V2_DIGEST_AFTER = "c9381c97a2967f260ab3d16e48b2c3fddddc394fb15562fb61d62d74bf693812";
const V1_DIGEST = "1f3d988f8f6c4ae406aca2a61c7afbc378a08f14d3ce47e8037228d9195c989b";
const PLAN_QUALITY_CHANGES: Array<{ path: string; expected: unknown; change: 7 }> = [
  {
    path: "steps[0].settings.instructions", change: 7,
    expected: [{
      agentName: "Rovara Code",
      text: [
        "Plan the input rules, the tests and the checks as well as the code.",
        "- Input: say exactly which values are accepted and which are rejected (empty, padded with spaces, signed, decimal, exponent, hex, below the minimum, above the maximum), and parse strictly. A loose conversion such as Number() or parseInt() accepts values the rule does not.",
        "- Tests: for each new option, plan a test alone, one combined with each existing option it can meet (such as filters), and one at each boundary: the minimum, the maximum, one past each, and a value above the number of available items.",
        "- Checks: list every check the repository's CI requires. Read its workflow files, and do not stop at lint.",
      ].join("\n"),
    }],
  },
  {
    path: "steps[2].settings.instructions", change: 7,
    expected: [{
      agentName: "Rovara Code",
      text: [
        "Validate input strictly: accept only the documented form and reject everything else with a clear error before doing any work.",
        "Do not rely on a loose conversion such as Number() or parseInt(), which accepts padding, exponents, hex and decimals.",
        "Write tests for each new option alone, combined with the existing options, and at its boundaries (the minimum, the maximum, one past each, and above the number of available items).",
        "Run the plan's checks and the repository's own test command before you finish.",
      ].join("\n"),
    }],
  },
];

describe("Rovara Code version 2's recipe after the plan-quality change", () => {
  const v2 = builtinRecipe("rovara-code", 2);

  it("is the recipe it was before, apart from change 7's two paths, each listed by value", () => {
    const before = structuredClone(v2) as unknown as Record<string, unknown>;
    for (const { path, expected } of PLAN_QUALITY_CHANGES) {
      expect(valueAt(v2, path), path).toEqual(expected);
      const parts = path.split(/\.|(?=\[)/u).filter(Boolean);
      const holder = parts.slice(0, -1).reduce<unknown>((node, part) => {
        const index = /^\[(\d+)\]$/u.exec(part);
        return (node as Record<string, unknown>)[index === null ? part : index[1]!];
      }, before) as Record<string, unknown>;
      holder[parts.at(-1)!] = [];
    }
    expect(recipeDigest(before as never), "version 2 before").toBe(V2_DIGEST_BEFORE);
    expect(recipeDigest(v2), "version 2 now").toBe(V2_DIGEST_AFTER);
    expect(BUILTIN_AGENTS["rovara-code"].versions[1]!.digest).toBe(V2_DIGEST_AFTER);
  });

  it("leaves version 1 untouched: its digest, and no instructions in any step", () => {
    const v1 = builtinRecipe("rovara-code", 1);
    expect(recipeDigest(v1)).toBe(V1_DIGEST);
    expect(BUILTIN_AGENTS["rovara-code"].versions[0]!.digest).toBe(V1_DIGEST);
    expect(JSON.stringify(v1)).not.toContain("Number()");
    for (const step of v1.steps) expect((step.settings as { instructions: unknown[] }).instructions, step.id).toEqual([]);
  });

  it("is what the digest fixture records, for version 2 only", () => {
    const recorded = JSON.parse(readFileSync(new URL("../fixtures/builtin-agent-digests.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
    expect(recorded["rovara-code"]).toEqual({ "1": V1_DIGEST, "2": V2_DIGEST_AFTER });
  });
});
