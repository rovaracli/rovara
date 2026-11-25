import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gate as integrity } from "../../ops/pipeline/gates/change-set-integrity.gate.ts";
import { buildInputs, main, parseArgs } from "../../ops/pipeline/stage.ts";
import { runStep } from "../../ops/pipeline/lib/run.ts";
import type { StepFunction } from "../../ops/pipeline/lib/run.ts";
import { parseManifest } from "../../ops/pipeline/lib/manifest.ts";
import { buildLastGood, parseLastGood } from "../../ops/pipeline/lib/lastgood.ts";
import { buildSummary, renderExports, renderSummary } from "../../ops/pipeline/lib/summary.ts";
import { preflight } from "../../ops/pipeline/steps/preflight.ts";
import { imageStep } from "../../ops/pipeline/steps/image-step.ts";
import { gatewayStep } from "../../ops/pipeline/steps/gateway.ts";
import { gatewayCheckStep } from "../../ops/pipeline/steps/gateway-check.ts";
import { webAppStep } from "../../ops/pipeline/steps/web-app.ts";
import { proofStep } from "../../ops/pipeline/steps/proof.ts";
import { StageError } from "../../ops/pipeline/types.ts";
import type { Gate, ImageStepResult, Manifest, PipelineEnv, StepName } from "../../ops/pipeline/types.ts";
import { seedLastGood, CDK_METADATA, DIGEST_A, DIGEST_B, EXEC8, FAKE_ACCOUNT, OTHER_ACCOUNT, EXEC_ID, MODIFY_FUNCTION, config, fakeSwitches, liveStack, makeCtx, makePorts, newState, row, sha, stackFor } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";
import type { Inputs } from "../../ops/pipeline/lib/context.ts";

const NAME = `rovara-pipeline-${EXEC8}`;
const okImage = (digest = DIGEST_A, source: ImageStepResult["source"] = "built") => (): Promise<ImageStepResult> => Promise.resolve({ digest, source, imageTag: `pipe-${EXEC8}-abc`, repository: "images" });
const pass = (name: string, phase: Gate["phases"][number]): Gate => ({ name, phases: [phase], run: () => Promise.resolve({ result: "pass" }) });

const STEPS: Record<StepName, StepFunction> = {
  preflight, image: (c, s) => imageStep(c, s, okImage()), gateway: gatewayStep, "gateway-check": gatewayCheckStep, "web-app": webAppStep, proof: proofStep,
};

/** A world where beta is live: three stacks, a gateway digest, and change sets cdk will create. */
function betaWorld(over: Partial<FakeState> = {}): FakeState {
  const state = newState({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION], RovaraModelGateway: [row("Modify", "TaskDef", "AWS::ECS::TaskDefinition", "True")] }, ...over });
  liveStack(state, stackFor("beta", "gateway"), { parameters: { ImageDigest: DIGEST_B } });
  liveStack(state, stackFor("beta", "web"), { outputs: { CloudUrl: "https://cloud.example.test/app" } });
  liveStack(state, stackFor("beta", "app"));
  seedLastGood(state, "beta");
  return state;
}

interface Run { state: FakeState; logs: string[]; gates: Gate[]; required: Record<string, string[]>; inputs: Partial<Inputs>; steps: Record<StepName, StepFunction> }
const newRun = (state: FakeState, over: Partial<Run> = {}): Run => ({ state, logs: [], gates: [integrity], required: { preflight: [], "change-sets": ["change-set-integrity"], "gateway-live": [], proof: [] }, inputs: {}, steps: STEPS, ...over });

/** Runs one step like a CodeBuild action: the previous action's manifest is the input artifact. */
async function step(run: Run, env: PipelineEnv, name: StepName, inputs: Partial<Inputs> = {}): Promise<void> {
  const previous = run.state.files["out/manifest.json"];
  if (previous !== undefined) run.state.files["/in/manifest.json"] = previous;
  const ctx = makeCtx(run.state, env, name, { inputs: { manifestPath: previous === undefined ? null : "/in/manifest.json", ...run.inputs, ...inputs }, gates: run.gates, required: run.required, logs: run.logs });
  await runStep(ctx, run.steps[name]);
}
const cdkAccountContext = (state: FakeState): string | undefined => state.calls.find((c) => c.startsWith("cdk-account "))?.slice("cdk-account ".length);
const manifestOf = (state: FakeState): Manifest => parseManifest(state.files["out/manifest.json"]!);
const executes = (state: FakeState): string[] => state.calls.filter((c) => c.startsWith("cfn execute"));
const failsWith = async (promise: Promise<unknown>, exitName: string, text?: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  if (text !== undefined) await expect(promise).rejects.toThrow(text);
};

describe("pipeline stage CLI: beta, step by step", () => {
  it("preflight resolves the ref, previews web and app (never executes), captures the rollback record and writes the outputs", async () => {
    const run = newRun(betaWorld());
    await step(run, "beta", "preflight");
    const m = manifestOf(run.state);
    expect(m).toMatchObject({ mode: "release", executionId: EXEC_ID, exec8: EXEC8, cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag" } });
    const stage = m.stages.beta!;
    expect(stage.completed).toEqual(["preflight"]);
    expect(stage.changeSets.map((c) => [c.part, c.changeSetName, c.noChanges])).toEqual([["app", NAME, false], ["web", NAME, false]]);
    expect(executes(run.state)).toEqual([]);
    expect(stage.rollback).toMatchObject({ env: "beta", gateway: { digest: DIGEST_B }, cloud: { sha: null }, stacks: { gateway: { status: "UPDATE_COMPLETE", templateSha256: "live-rovara-cloud-beta-gateway" } } });
    expect(stage.account).toBe(FAKE_ACCOUNT);
    expect(cdkAccountContext(run.state)).toBe(FAKE_ACCOUNT);
    const cdk = run.state.calls.find((c) => c.startsWith("cdk "))!;
    expect(cdk).toContain("RovaraCloudApp,RovaraCloudWeb");
    expect(cdk).toContain("agentxAccount");
    expect(cdk).toContain("rovaraCloudSha");
    expect(cdk).toContain("params=rovara-cloud-beta-app:CodeUrl=https://beta-code.example.test,rovara-cloud-beta-web:CodeUrl=https://beta-code.example.test");
    expect(run.state.calls).toContain(`git worktree ${sha("4").slice(0, 7)} /work/cloud-${sha("4").slice(0, 12)}`);
    expect(run.state.calls.filter((c) => c.startsWith("exec bash -c")).map((c) => c.slice("exec bash -c ".length))).toEqual(["npm ci", "npx tsc -b infra", "npx tsc -b packages/model-gateway", "npm run build:web"]);
    expect(run.state.files["out/summary.txt"]).toMatch(/^PROMOTION SUMMARY beta {2}execution 1a2b3c4d {2}mode release/u);
    const exportsFile = run.state.files["out/exports.env"]!;
    expect(exportsFile).toContain("export CLOUD_TAG='v0.13.10'");
    expect(exportsFile).toContain("export CODE_RELEASE_EFFECTIVE='run'");
    expect(Object.keys(run.state.files).filter((f) => f.startsWith("out/change-sets/")).sort()).toEqual(["out/change-sets/rovara-cloud-beta-app.json", "out/change-sets/rovara-cloud-beta-web.json"]);
  });

  it("walks the whole beta stage: image, gateway (only ImageDigest), gateway-check, web-app with the release check, proof and last-good", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p1", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    const m = manifestOf(run.state);
    expect(m.stages.beta!.completed).toEqual(["preflight", "image", "gateway", "gateway-check", "web-app", "proof"]);
    expect(m.gateway).toMatchObject({ digest: DIGEST_A, source: "built" });
    const cdkCalls = run.state.calls.filter((c) => c.startsWith("cdk "));
    expect(cdkCalls[1]).toMatch(new RegExp(`^cdk RovaraModelGateway ${NAME} ctx=.*rovaraCloudSha.* params=rovara-cloud-beta-gateway:ImageDigest=${DIGEST_A}$`, "u"));
    expect(cdkCalls[1]).not.toContain("agentxAccount");
    expect(executes(run.state)).toEqual([`cfn execute ${stackFor("beta", "gateway")} ${NAME}`, `cfn execute ${stackFor("beta", "app")} ${NAME}`, `cfn execute ${stackFor("beta", "web")} ${NAME}`]);
    expect(m.stages.beta!.releaseCheck).toMatchObject({ base: "https://cloud.example.test", failures: [] });
    const lastGood = parseLastGood(run.state.ssm["/rovara-cloud/beta/release/last-good"]!);
    expect(lastGood).toMatchObject({ env: "beta", cloud: { tag: "v0.13.10", sha: sha("4") }, gateway: { digest: DIGEST_A }, proofGates: ["p1"], previous: { cloudTag: "v0.13.1", cloudSha: sha("1"), gatewayDigest: DIGEST_B }, code: { sha: sha("c") } });
    expect(m.stages.beta!.gates.map((g) => `${g.phase}/${g.name}`).sort()).toEqual(["change-sets/change-set-integrity", "change-sets/change-set-integrity", "gateway-live/g2", "proof/p1"]);
    expect(run.state.calls.filter((c) => c.startsWith("cfn delete")).length).toBeGreaterThan(0);
  });

  it("records the previous last-good in the next one", async () => {
    const run = newRun(betaWorld());
    run.state.ssm["/rovara-cloud/beta/release/last-good"] = JSON.stringify({ schema: 1, env: "beta", recordedAt: "2026-11-20T00:00:00.000Z", executionId: "old", mode: "release", cloud: { tag: "v0.13.1", sha: sha("1") }, gateway: { digest: DIGEST_B }, extraKeyFromTheFuture: true });
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    expect(parseLastGood(run.state.ssm["/rovara-cloud/beta/release/last-good"]).previous).toEqual({ cloudTag: "v0.13.1", cloudSha: sha("1"), gatewayDigest: DIGEST_B });
  });

  it("does not write last-good when a proof gate fails", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, { name: "p-bad", phases: ["proof"], run: () => Promise.resolve({ result: "fail", failures: ["snapshot too old"] }) }];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app"] as StepName[]) await step(run, "beta", name);
    const before = JSON.stringify(run.state.ssm);
    await failsWith(step(run, "beta", "proof"), "GATE_FAILED", /p-bad/);
    expect(JSON.stringify(run.state.ssm)).toBe(before);
    expect(manifestOf(run.state).stages.beta!.completed).not.toContain("proof");
  });

  it("a failing preflight gate stops before any change set is created, and still writes the manifest and verdicts", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, { name: "g-bad", phases: ["preflight"], run: () => Promise.resolve({ result: "fail", failures: ["drift"] }) }];
    await failsWith(step(run, "beta", "preflight"), "GATE_FAILED");
    expect(run.state.calls.some((c) => c.startsWith("cdk "))).toBe(false);
    expect(run.state.files["out/gates/preflight-g-bad.json"]).toBeDefined();
    expect(manifestOf(run.state).stages.beta!.completed).toEqual([]);
  });

  describe("with the committed gate policy", () => {
    const LIST_PATH = new URL("../../ops/pipeline/protected.json", import.meta.url).pathname;
    // Every required gate that is not under test passes: only the protected gate is real here.
    const others = (): Gate[] => [integrity, pass("own-key-backfill", "preflight"), pass("gitleaks", "preflight"), pass("deployed-drift", "preflight"), pass("gateway-runprice", "gateway-live"), pass("gateway-settled", "gateway-live"), { name: "rollback-floor", phases: ["preflight", "change-sets"], run: () => Promise.resolve({ result: "pass" }) }];
    const policyRun = async (state: FakeState, gates: Gate[]): Promise<Run> => {
      const { loadGatePolicy } = await import("../../ops/pipeline/config.ts");
      state.files[LIST_PATH] = readFileSync(LIST_PATH, "utf8");
      const run = newRun(state);
      run.required = loadGatePolicy().required;
      run.gates = gates;
      return run;
    };

    it("a run stops at exit 21 after the preview and executes nothing when the protected gate is missing", async () => {
      const run = await policyRun(betaWorld(), others());
      await failsWith(step(run, "beta", "preflight"), "GATE_MISSING", /protected/);
      expect(executes(run.state)).toEqual([]);
      expect(manifestOf(run.state).stages.beta!.completed).toEqual([]);
    });

    it("with the real protected gate, clean change sets pass preflight (nothing is executed in preflight)", async () => {
      const { gate: protectedGate } = await import("../../ops/pipeline/gates/protected.gate.ts");
      const run = await policyRun(betaWorld(), [...others(), protectedGate]);
      await step(run, "beta", "preflight");
      const stage = manifestOf(run.state).stages.beta!;
      expect(stage.completed).toEqual(["preflight"]);
      expect(stage.gates.find((g) => g.name === "protected")).toMatchObject({ result: "pass", scope: "app+web" });
      expect(executes(run.state)).toEqual([]);
    });

    it("a protected Replace stops the step (exit 20) after the preview and before any execute, with the verdict written", async () => {
      const { gate: protectedGate } = await import("../../ops/pipeline/gates/protected.gate.ts");
      const state = betaWorld({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [row("Modify", "State1C20CC9A", "AWS::DynamoDB::GlobalTable", "Conditional")] } });
      const run = await policyRun(state, [...others(), protectedGate]);
      await failsWith(step(run, "beta", "preflight"), "GATE_FAILED", /protected/);
      expect(executes(run.state)).toEqual([]);
      expect(JSON.parse(run.state.files["out/gates/change-sets-protected.json"]!)).toMatchObject({ result: "fail" });
    });
  });

  it("a missing change set after a successful cdk call stops the step (exit 30), and nothing reaches last-good", async () => {
    const run = newRun(betaWorld({ plan: { RovaraCloudApp: [CDK_METADATA] } }));
    const before = JSON.stringify(run.state.ssm);
    await failsWith(step(run, "beta", "preflight"), "CHANGE_SET_MISMATCH", /does not exist/);
    expect(JSON.stringify(run.state.ssm)).toBe(before);
  });

  it("a missing required gate is exit GATE_MISSING", async () => {
    const run = newRun(betaWorld());
    run.required = { ...run.required, preflight: ["own-key-backfill"] };
    await failsWith(step(run, "beta", "preflight"), "GATE_MISSING", /own-key-backfill/);
  });

  it("the change-set gates see the previewed web and app change sets, and a failure there leaves them unexecuted", async () => {
    const seen: string[] = [];
    const spy: Gate = { name: "spy", phases: ["change-sets"], run: (i) => { seen.push(i.changeSets.map((c) => c.part).join("+")); return Promise.resolve({ result: "fail", failures: ["protected row"] }); } };
    const run = newRun(betaWorld());
    run.gates = [integrity, spy];
    await failsWith(step(run, "beta", "preflight"), "GATE_FAILED", /spy/);
    expect(seen).toEqual(["app+web"]);
    expect(executes(run.state)).toEqual([]);
    // and the unexecuted change sets of this run are deleted, not left behind
    expect(Object.keys(run.state.changeSets)).toEqual([]);
    expect(run.state.calls.filter((c) => c.startsWith("cfn delete"))).toEqual([`cfn delete ${stackFor("beta", "app")} ${NAME}`, `cfn delete ${stackFor("beta", "web")} ${NAME}`]);
  });

  it("a cdk failure in the gateway step (the incident: cdk refused a parameter) deletes the change sets this call made and nothing else, then fails the step", async () => {
    const run = newRun(betaWorld());
    await step(run, "beta", "preflight");
    await step(run, "beta", "image");
    const gatewayStack = stackFor("beta", "gateway");
    const original = run.state.calls.length;
    const real = makePorts(run.state);
    // cdk creates the change set, then dies (a second stack of the call rejected a parameter): the step must clean up what exists
    run.steps = { ...run.steps, gateway: (c, st) => gatewayStep({ ...c, ports: { ...c.ports, cdk: { deployNoExecute: async (a) => { await real.cdk.deployNoExecute(a); throw new StageError("FAILED", "cdk deploy --no-execute failed (exit 1): Parameters: [ImageDigest] do not exist in the template"); } } } }, st) };
    await failsWith(step(run, "beta", "gateway"), "FAILED", /do not exist in the template/);
    expect(Object.keys(run.state.changeSets).sort()).toEqual([`${stackFor("beta", "app")}/${NAME}`, `${stackFor("beta", "web")}/${NAME}`]); // preflight's stay: they belong to the later web-app step of this execution
    expect(run.state.calls.slice(original).filter((c) => c.startsWith("cfn delete"))).toEqual([`cfn delete ${gatewayStack} ${NAME}`]);
    expect(executes(run.state)).toEqual([]);
  });

  it("a gate refusing the web and app change sets at web-app (nothing executed) deletes them", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live")];
    for (const name of ["preflight", "image", "gateway", "gateway-check"] as StepName[]) await step(run, "beta", name);
    // the environment changed after the preview: the recorded change set is no longer the live one
    run.state.changeSets[`${stackFor("beta", "app")}/${NAME}`]!.id = "someone-else";
    await failsWith(step(run, "beta", "web-app"), "CHANGE_SET_MISMATCH");
    expect(Object.keys(run.state.changeSets).filter((k) => k.includes("-web/") || k.includes("-app/"))).toEqual([]);
  });

  it("the gateway step gives the change-set gates ONLY the gateway change set and does not execute when one fails", async () => {
    const seen: string[] = [];
    const spy: Gate = { name: "spy", phases: ["change-sets"], run: (i) => { seen.push(i.changeSets.map((c) => c.part).join("+")); return Promise.resolve({ result: i.changeSets[0]!.part === "gateway" ? "fail" : "pass", failures: ["protected row"] }); } };
    const run = newRun(betaWorld());
    run.gates = [integrity, spy];
    await step(run, "beta", "preflight");
    await step(run, "beta", "image");
    await failsWith(step(run, "beta", "gateway"), "GATE_FAILED");
    expect(seen).toEqual(["app+web", "gateway"]);
    expect(executes(run.state)).toEqual([]);
  });

  it("refuses a step whose predecessor has not completed, and is a no-op for a step that already completed", async () => {
    const run = newRun(betaWorld());
    await step(run, "beta", "preflight");
    await failsWith(step(run, "beta", "gateway"), "REFUSED", /comes after image/);
    await failsWith(step(run, "beta", "web-app"), "REFUSED");
    await step(run, "beta", "image");
    const before = run.state.calls.length;
    await step(run, "beta", "image");
    expect(run.state.calls.length).toBe(before);
    expect(run.logs.some((l) => /already completed/.test(l))).toBe(true);
    expect(manifestOf(run.state).stages.beta!.completed).toEqual(["preflight", "image"]);
  });

  it("refuses a manifest from another execution", async () => {
    const run = newRun(betaWorld());
    await step(run, "beta", "preflight");
    await failsWith(step(run, "beta", "image", { execId: "1a2b3c4d-0000-4000-8000-0000000000ff" }), "REFUSED", /belongs to execution/);
  });

  it("refuses the wrong region or account before anything is read or written", async () => {
    const wrongAccount = newRun(betaWorld({ account: OTHER_ACCOUNT }));
    await failsWith(step(wrongAccount, "beta", "preflight"), "REFUSED", /does not match the expected deploy account/);
    expect(wrongAccount.state.calls.some((c) => c.startsWith("cdk "))).toBe(false);
    await failsWith(step(newRun(betaWorld()), "beta", "preflight", { region: "us-west-2" }), "REFUSED", /AWS_REGION is us-west-2/);
    const unset = newRun(betaWorld());
    await failsWith(step(unset, "beta", "preflight", { expectedAccount: null }), "REFUSED", /expected deploy account.*not set/);
    expect(unset.state.calls.some((c) => c.startsWith("cdk "))).toBe(false);
  });

  it("a release check failure fails web-app even though the deploy succeeded", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live")];
    for (const name of ["preflight", "image", "gateway", "gateway-check"] as StepName[]) await step(run, "beta", name);
    run.state.http = (url) => (url.endsWith("/app") ? 502 : 401);
    await failsWith(step(run, "beta", "web-app"), "RELEASE_CHECK_FAILED", /\/app 502/);
    expect(executes(run.state)).toHaveLength(3);
    expect(manifestOf(run.state).stages.beta!.completed).not.toContain("web-app");
  });

  it("dry run creates and executes nothing", async () => {
    const run = newRun(betaWorld(), { inputs: { dryRun: true } });
    await step(run, "beta", "preflight");
    expect(run.state.calls.some((c) => c.startsWith("cdk ") || c.startsWith("cfn execute"))).toBe(false);
    expect(manifestOf(run.state).stages.beta!.warnings.join(" ")).toMatch(/dry run/);
  });
});

describe("pipeline stage CLI: modes", () => {
  it("a rollback forces Code to skip and pins it to the live Code sha; without the sha it refuses (exit 41)", async () => {
    const world = () => { const s = betaWorld({ history: [sha("1"), sha("2"), sha("3"), sha("4")] }); s.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("4"); return s; };
    await failsWith(step(newRun(world()), "beta", "preflight", { cloudRef: "v0.13.2" }), "ROLLBACK_REFUSED", /CODE_LIVE_SHA/);
    const run = newRun(world());
    await step(run, "beta", "preflight", { cloudRef: "v0.13.2", codeLiveSha: sha("d"), codeLiveFacts: { workerDigest: "sha256:w" } });
    const m = manifestOf(run.state);
    expect(m).toMatchObject({ mode: "rollback", cloud: { tag: "v0.13.2", sha: sha("2") }, code: { release: "skip", requestedRelease: "run", pinnedSha: { beta: sha("d"), production: null } } });
    expect(m.stages.beta!.rollback).toMatchObject({ cloud: { tag: "v0.13.10", sha: sha("4") }, code: { liveSha: sha("d"), facts: { workerDigest: "sha256:w" } } });
    expect(run.state.files["out/summary.txt"]).toMatch(/rollback run: Code is skipped and pinned to d{12}/);
    expect(run.state.files["out/exports.env"]).toContain("export CODE_RELEASE_EFFECTIVE='skip'");
    expect(run.state.files["out/exports.env"]).toContain(`export CODE_PINNED_SHA='${sha("d")}'`);
  });

  it("an adoption run keeps the live digest, never calls the image build, and refuses any real row", async () => {
    const state = betaWorld({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [CDK_METADATA], RovaraModelGateway: [CDK_METADATA] } });
    state.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("3");
    const run = newRun(state, { inputs: { adopt: true, cloudRef: "v0.13.9", codeRelease: "skip" } });
    run.steps = { ...STEPS, image: (c, s) => imageStep(c, s, () => Promise.reject(new Error("must not be called"))) };
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    expect(manifestOf(run.state).gateway).toMatchObject({ digest: DIGEST_B, source: "adopted" });
    expect(run.state.calls.find((c) => c.startsWith("cdk RovaraModelGateway"))).toContain(`ImageDigest=${DIGEST_B}`);
    const dirty = betaWorld({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION], RovaraModelGateway: null } });
    dirty.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("3");
    await failsWith(step(newRun(dirty, { inputs: { adopt: true, cloudRef: "v0.13.9" } }), "beta", "preflight"), "GATE_FAILED", /change-set-integrity/);
  });
});

describe("pipeline stage CLI: the first release is an adoption run", () => {
  const noRecord = (over: Partial<FakeState> = {}): FakeState => { const state = betaWorld(over); state.ssm = {}; return state; };

  it("refuses a release run in an environment with no last-good record (exit 42), before any build or change set", async () => {
    const run = newRun(noRecord());
    await failsWith(step(run, "beta", "preflight"), "ADOPTION_REQUIRED", /first release must be an adoption run/);
    expect(run.state.calls.some((c) => c.startsWith("cdk ") || c.startsWith("git worktree"))).toBe(false);
  });

  it("refuses a rollback run there too", async () => {
    const state = noRecord();
    state.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("4");
    await failsWith(step(newRun(state), "beta", "preflight", { cloudRef: "v0.13.2", codeLiveSha: sha("d") }), "ADOPTION_REQUIRED");
  });

  it("an adoption run keeps today's rules and needs no record", async () => {
    const state = noRecord({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [CDK_METADATA], RovaraModelGateway: [CDK_METADATA] } });
    state.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("3");
    const run = newRun(state, { inputs: { adopt: true, cloudRef: "v0.13.9", codeRelease: "skip" } });
    await step(run, "beta", "preflight");
    expect(manifestOf(run.state).mode).toBe("adoption");
  });

  it("an adoption run's proof writes the first last-good, after which a release run is allowed", async () => {
    const state = noRecord({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [CDK_METADATA], RovaraModelGateway: [CDK_METADATA] } });
    state.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("3");
    const run = newRun(state, { inputs: { adopt: true, cloudRef: "v0.13.9", codeRelease: "skip" } });
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    run.steps = { ...STEPS, image: (c, s) => imageStep(c, s, () => Promise.reject(new Error("must not be called"))) };
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    expect(JSON.parse(state.ssm["/rovara-cloud/beta/release/last-good"]!)).toMatchObject({ mode: "adoption" });
    const next = newRun(state);
    delete state.files["out/manifest.json"];
    await step(next, "beta", "preflight");
    expect(manifestOf(state).mode).toBe("release");
  });

  it("production without its own record is refused too, even when beta has one", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    const prod = betaWorld();
    for (const part of ["gateway", "web", "app"] as const) { prod.stacks[stackFor("production", part)] = { ...prod.stacks[stackFor("beta", part)]!, templateSha: "x" }; delete prod.stacks[stackFor("beta", part)]; }
    prod.files = { ...run.state.files }; prod.ssm = {};
    await failsWith(step(newRun(prod, { inputs: { cloudProd: true } }), "production", "preflight"), "ADOPTION_REQUIRED", /production has no last-good/);
  });

  it("PIPELINE_MODE is release or adopt, adopt means an adoption run, and it cannot contradict --adopt", () => {
    const base = { EXEC_ID, AWS_REGION: "us-east-1" };
    expect(buildInputs({}, { ...base }, new Date()).adopt).toBe(false);
    expect(buildInputs({}, { ...base, PIPELINE_MODE: "release" }, new Date()).adopt).toBe(false);
    expect(buildInputs({}, { ...base, PIPELINE_MODE: "adopt" }, new Date()).adopt).toBe(true);
    expect(buildInputs({ adopt: true }, { ...base, PIPELINE_MODE: "adopt" }, new Date()).adopt).toBe(true);
    expect(buildInputs({}, { ...base, PIPELINE_MODE: "rollback" }, new Date())).toMatchObject({ adopt: false, declaredRollback: true });
    expect(buildInputs({}, { ...base }, new Date()).declaredRollback).toBe(false);
    expect(() => buildInputs({}, { ...base, PIPELINE_MODE: "backwards" }, new Date())).toThrow(/release, adopt or rollback/);
    expect(() => buildInputs({}, { ...base, PIPELINE_MODE: "rollback", PIPELINE_ADOPT: "1" }, new Date())).toThrow(/contradicts/);
    expect(() => buildInputs({}, { ...base, PIPELINE_MODE: "release", PIPELINE_ADOPT: "1" }, new Date())).toThrow(/contradicts/);
  });
});

describe("pipeline stage CLI: a dry run is never proof, and never mixed with a real one", () => {
  const prodWorld = (): FakeState => {
    const prod = betaWorld();
    for (const part of ["gateway", "web", "app"] as const) { prod.stacks[stackFor("production", part)] = { ...prod.stacks[stackFor("beta", part)]!, templateSha: "x" }; delete prod.stacks[stackFor("beta", part)]; }
    seedLastGood(prod, "production");
    return prod;
  };
  /** A complete beta execution (real or dry), as the manifest the production action would be handed. */
  const betaManifest = async (dry: boolean): Promise<Record<string, string>> => {
    const run = newRun(betaWorld(), { inputs: { dryRun: dry } });
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    if (dry) {
      await step(run, "beta", "preflight");
      const m = JSON.parse(run.state.files["out/manifest.json"]!) as { stages: { beta: { completed: string[] } } };
      m.stages.beta.completed = ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"]; // a dry run that got that far
      run.state.files["out/manifest.json"] = JSON.stringify(m);
    } else for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    return run.state.files;
  };

  it("records dryRun per stage", async () => {
    const dry = await betaManifest(true);
    expect(parseManifest(dry["out/manifest.json"]!).stages.beta!.dryRun).toBe(true);
    expect(parseManifest((await betaManifest(false))["out/manifest.json"]!).stages.beta!.dryRun).toBe(false);
  });

  it("production preflight refuses a dry beta proof, real or dry production, and runs nothing", async () => {
    const files = await betaManifest(true);
    for (const dryRun of [false, true]) {
      const prod = prodWorld();
      prod.files = { ...files };
      await failsWith(step(newRun(prod, { inputs: { cloudProd: true, dryRun } }), "production", "preflight"), "REFUSED");
      expect(prod.calls.some((c) => c.startsWith("cdk ") || c.startsWith("git worktree"))).toBe(false);
    }
    const prod = prodWorld();
    prod.files = { ...files };
    await failsWith(step(newRun(prod, { inputs: { cloudProd: true, dryRun: true } }), "production", "preflight"), "REFUSED", /was a dry run/);
  });

  it("a real run cannot be mixed into an execution that has a dry stage, nor a dry one into a real stage", async () => {
    const dryFiles = await betaManifest(true);
    const a = prodWorld();
    a.files = { ...dryFiles };
    await failsWith(step(newRun(a, { inputs: { cloudProd: true } }), "production", "preflight"), "REFUSED", /dry beta stage: a real run cannot be mixed/);
    const realFiles = await betaManifest(false);
    const b = prodWorld();
    b.files = { ...realFiles };
    await failsWith(step(newRun(b, { inputs: { cloudProd: true, dryRun: true } }), "production", "preflight"), "REFUSED", /real beta stage: a dry run cannot be mixed/);
    // also inside one stage: a dry step cannot mark a real stage's step done
    const c = betaWorld();
    const real = newRun(c);
    await step(real, "beta", "preflight");
    await failsWith(step(real, "beta", "image", { dryRun: true }), "REFUSED", /cannot be mixed/);
    expect(parseManifest(c.files["out/manifest.json"]!).stages.beta!.completed).toEqual(["preflight"]);
  });

  it("a stage record that does not say it was real (written before the field) is not proof for production", async () => {
    const files = { ...(await betaManifest(false)) };
    const m = JSON.parse(files["out/manifest.json"]!) as { stages: { beta: Record<string, unknown> } };
    delete m.stages.beta.dryRun;
    files["out/manifest.json"] = JSON.stringify(m);
    expect(parseManifest(files["out/manifest.json"]).stages.beta!.dryRun).toBeNull();
    const prod = prodWorld();
    prod.files = { ...files };
    await failsWith(step(newRun(prod, { inputs: { cloudProd: true } }), "production", "preflight"), "REFUSED", /does not say it was real/);
  });

  it("a real beta execution still reaches a real production preflight", async () => {
    const prod = prodWorld();
    prod.files = { ...(await betaManifest(false)) };
    const run = newRun(prod, { inputs: { cloudProd: true, expectedAccount: FAKE_ACCOUNT } });
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    await step(run, "production", "preflight");
    expect(parseManifest(prod.files["out/manifest.json"]!).stages.production).toMatchObject({ dryRun: false, completed: ["preflight"] });
  });
});

describe("pipeline stage CLI: CLOUD_REF=from-trigger through the stages", () => {
  const FIRST = { cloudRef: "from-trigger", cloudSourceCommit: sha("3") };
  const writes = (state: FakeState): string[] => state.calls.filter((c) => /^(cfn|cdk|ssm put|aws|git worktree)/u.test(c));

  it("beta resolves the tag on the source commit and records how; the manifest carries it on", async () => {
    const run = newRun(betaWorld(), { inputs: FIRST });
    await step(run, "beta", "preflight");
    expect(manifestOf(run.state).cloud).toMatchObject({ tag: "v0.13.9", sha: sha("3"), ref: "from-trigger" });
    expect(run.state.calls.find((c) => c.startsWith("cdk "))).toContain("rovaraCloudSha");
  });

  it("a Code push (no tag on the commit) keeps beta's recorded Cloud: the release proceeds on that Cloud", async () => {
    const state = betaWorld();
    state.history.push(sha("5"));
    const run = newRun(state, { inputs: { cloudRef: "from-trigger", cloudSourceCommit: sha("5") } });
    await step(run, "beta", "preflight");
    expect(manifestOf(run.state).cloud).toMatchObject({ tag: "v0.13.1", sha: sha("1"), ref: "last-good" });
    // the candidate is the RECORDED tag's commit, never the trunk commit handed in
    const worktrees = run.state.calls.filter((c) => c.startsWith("git worktree"));
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toContain(`git worktree ${sha("1").slice(0, 7)} `);
    expect(worktrees[0]).not.toContain(sha("5").slice(0, 7));
    expect(run.state.calls.find((c) => c.startsWith("cdk "))).toBeDefined();
  });

  it("refuses before any write when the commit has two tags, is off the trunk, or CLOUD_SOURCE_COMMIT is missing", async () => {
    const two = betaWorld();
    two.tags["v0.13.11"] = sha("3");
    for (const [state, commit, text] of [[two, sha("3"), /carries 2 release tags/u], [betaWorld(), sha("9"), /not on cloud\/next/u], [betaWorld(), null, /needs CLOUD_SOURCE_COMMIT/u]] as const) {
      const run = newRun(state, { inputs: { cloudRef: "from-trigger", cloudSourceCommit: commit } });
      await failsWith(step(run, "beta", "preflight"), "REF_FAILED", text);
      expect(writes(run.state)).toEqual([]);
      expect(run.state.files["out/manifest.json"]).toBeUndefined();
    }
  });

  it("an adoption run still has to name the tag (from-trigger does not adopt)", async () => {
    const run = newRun(betaWorld(), { inputs: { ...FIRST, adopt: true } });
    await failsWith(step(run, "beta", "preflight"), "REFUSED", /set CLOUD_REF/u);
  });

  it("production deploys what beta resolved: from-trigger with no source commit is not re-resolved, and a different explicit tag is refused", async () => {
    const beta = newRun(betaWorld(), { inputs: FIRST });
    beta.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(beta, "beta", name);
    const prod = betaWorld();
    for (const part of ["gateway", "web", "app"] as const) { prod.stacks[stackFor("production", part)] = { ...prod.stacks[stackFor("beta", part)]!, templateSha: "x" }; delete prod.stacks[stackFor("beta", part)]; }
    seedLastGood(prod, "production");
    prod.files = { ...beta.state.files };
    prod.tags["v0.13.11"] = sha("4"); // something newer exists: it must not be picked up
    const run = newRun(prod, { inputs: { cloudRef: "from-trigger", cloudSourceCommit: null, cloudProd: true, expectedAccount: FAKE_ACCOUNT } });
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    await step(run, "production", "preflight");
    expect(manifestOf(prod).cloud).toMatchObject({ tag: "v0.13.9", sha: sha("3") });
    expect(prod.calls.some((c) => c.startsWith("git fetchTags"))).toBe(false); // nothing was re-resolved
    expect(prod.calls.find((c) => c.startsWith("git worktree"))).toContain(sha("3").slice(0, 7));
    const other = newRun(prod, { inputs: { cloudRef: "v0.13.10", cloudProd: true, expectedAccount: FAKE_ACCOUNT } });
    other.gates = run.gates;
    prod.files["out/manifest.json"] = beta.state.files["out/manifest.json"]!;
    await failsWith(step(other, "production", "preflight"), "REFUSED", /not the release Beta resolved/u);
  });
});

describe("pipeline stage CLI: production joins what beta resolved", () => {
  const prodFrom = async (inputs: Partial<Inputs>, tweak: (files: Record<string, string>) => void = () => {}) => {
    const beta = newRun(betaWorld(), { inputs: { cloudRef: "from-trigger", cloudSourceCommit: sha("3"), ...inputs } });
    beta.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(beta, "beta", name);
    const prod = betaWorld();
    for (const part of ["gateway", "web", "app"] as const) { prod.stacks[stackFor("production", part)] = { ...prod.stacks[stackFor("beta", part)]!, templateSha: "x" }; delete prod.stacks[stackFor("beta", part)]; }
    seedLastGood(prod, "production");
    prod.files = { ...beta.state.files };
    tweak(prod.files);
    return prod;
  };

  it("refuses when beta left no resolved Cloud release in the manifest (production never resolves one)", async () => {
    for (const edit of [(m: { cloud: { sha: string; tag: string } }) => { m.cloud.sha = "abc"; }, (m: { cloud: { sha: string; tag: string } }) => { m.cloud.tag = "cloud/next"; }]) {
      const prod = await prodFrom({}, (files) => { const m = JSON.parse(files["out/manifest.json"]!) as { cloud: { sha: string; tag: string } }; edit(m); files["out/manifest.json"] = JSON.stringify(m); });
      const run = newRun(prod, { inputs: { cloudRef: "v0.13.9", cloudProd: true, expectedAccount: FAKE_ACCOUNT } });
      run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
      await failsWith(step(run, "production", "preflight"), "REFUSED", /Beta left no resolved Cloud release/u);
      expect(prod.calls.some((c) => c.startsWith("git fetchTags"))).toBe(false);
    }
  });

  const skipped = async (prodLive: string | null, betaInputs: Partial<Inputs> = {}) => {
    const prod = await prodFrom(betaInputs, () => {});
    if (prodLive !== null) liveStack(prod, stackFor("production", "web"), { outputs: { DeployedCloudSha: prodLive } });
    const run = newRun(prod, { inputs: { cloudProd: false } });
    await step(run, "production", "preflight");
    return { stage: manifestOf(prod).stages.production!, run };
  };

  it("warns when Code is promoted next to an OLDER production Cloud than the one beta tested (CLOUD_PROD off), and says nothing otherwise", async () => {
    const older = await skipped(sha("2"));
    expect(older.stage.skipped).toBe("CLOUD_PROD=off");
    expect(older.stage.warnings.join(" ")).toMatch(/promoted next to an OLDER production Cloud \(222222222\) than the one Beta tested \(v0\.13\.9/u);
    expect(older.run.logs.join("\n")).toMatch(/WARNING: Code is promoted next to an OLDER/u);
    expect((await skipped(sha("3"))).stage.warnings).toEqual([]); // the same Cloud
    expect((await skipped(sha("4"))).stage.warnings).toEqual([]); // a NEWER production Cloud is not "older"
    expect((await skipped(sha("2"), { codeRelease: "skip" })).stage.warnings).toEqual([]);
  });

  it("an unreadable or unknown production Cloud is said, never a failure of the skip", async () => {
    expect((await skipped(null)).stage.warnings.join(" ")).toMatch(/cannot be compared|could not read/u);
  });
});

describe("pipeline stage CLI: the image step", () => {
  const afterPreflight = async (): Promise<Run> => { const run = newRun(betaWorld()); await step(run, "beta", "preflight"); return run; };

  it("the real image step (lane L6) refuses cleanly when the environment has no gateway-images stack, and records nothing", async () => {
    const run = await afterPreflight();
    run.steps = { ...STEPS, image: imageStep };
    await failsWith(step(run, "beta", "image"), "REFUSED", /rovara-cloud-beta-gateway-images does not exist/);
    expect(manifestOf(run.state).gateway.digest).toBeNull();
  });

  it("passes L6 the candidate tree, the supplied digest, and rejects a result that is not a digest", async () => {
    const run = await afterPreflight();
    let seen: unknown;
    run.steps = { ...STEPS, image: (c, s) => imageStep(c, s, (input) => { seen = { supplied: input.supplied, cloud: input.dirs.cloud, env: input.env }; return Promise.resolve({ digest: "latest", source: "built", imageTag: "t", repository: "r" }); }) };
    await failsWith(step(run, "beta", "image", { gatewayDigest: DIGEST_B }), "FAILED", /not sha256/);
    expect(seen).toEqual({ supplied: { digest: DIGEST_B }, cloud: `/work/cloud-${sha("4").slice(0, 12)}`, env: "beta" });
    await failsWith(step(run, "beta", "image", { gatewayDigest: "sha256:short" }), "USAGE");
  });

  it("production copies beta's digest: it must exist, take no supplied digest, and come back identical", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    // production world
    const prod = betaWorld();
    for (const part of ["gateway", "web", "app"] as const) { prod.stacks[stackFor("production", part)] = { ...prod.stacks[stackFor("beta", part)]!, templateSha: `live-prod-${part}` }; delete prod.stacks[stackFor("beta", part)]; }
    prod.files = { ...run.state.files }; prod.account = OTHER_ACCOUNT;
    seedLastGood(prod, "production");
    const prodRun = newRun(prod, { inputs: { cloudProd: true, expectedAccount: OTHER_ACCOUNT } });
    prodRun.gates = run.gates;
    prodRun.steps = { ...STEPS, image: (c, s) => imageStep(c, s, okImage(DIGEST_B, "copied")) };
    await step(prodRun, "production", "preflight");
    await failsWith(step(prodRun, "production", "image", { gatewayDigest: DIGEST_B }), "REFUSED", /takes no GATEWAY_DIGEST/);
    await failsWith(step(prodRun, "production", "image"), "REFUSED", /differs from the beta digest/);
    prodRun.steps = { ...STEPS, image: (c, s) => imageStep(c, s, okImage(DIGEST_A, "copied")) };
    await step(prodRun, "production", "image");
    expect(manifestOf(prod).gateway).toMatchObject({ digest: DIGEST_A, source: "copied" });
    expect(manifestOf(prod).stages.production!.account).toBe(OTHER_ACCOUNT);
    expect(manifestOf(prod).stages.beta!.completed).toContain("proof");
  });

  it("production with CLOUD_PROD off skips every step with exit 0 and leaves the beta record alone", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live"), pass("p", "proof")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "beta", name);
    const calls = run.state.calls.length;
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, "production", name, { cloudProd: false });
    expect(run.state.calls.length).toBe(calls);
    expect(manifestOf(run.state).stages.production).toMatchObject({ skipped: "CLOUD_PROD=off", completed: [] });
  });

  it("production preflight refuses a manifest whose beta stage did not finish its proof in this execution", async () => {
    const run = newRun(betaWorld());
    run.gates = [integrity, pass("g2", "gateway-live")];
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app"] as StepName[]) await step(run, "beta", name);
    const prod = betaWorld();
    prod.files = { ...run.state.files };
    const prodRun = newRun(prod, { inputs: { cloudProd: true } });
    await failsWith(step(prodRun, "production", "preflight"), "REFUSED", /beta's proof/);
    expect(prod.calls.some((c) => c.startsWith("cdk "))).toBe(false);
  });

  it("production preflight needs a manifest and, in a rollback, its own CODE_LIVE_SHA", async () => {
    await failsWith(step(newRun(betaWorld()), "production", "preflight", { cloudProd: true }), "REFUSED", /needs the manifest/);
  });
});

describe("pipeline stage CLI: records", () => {
  it("reads a manifest tolerantly (extra keys, missing optionals) and refuses a wrong schema or missing required values", () => {
    const base = { schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode: "release", cloud: { tag: "v1.0.0", sha: sha("a"), trunk: "cloud/next", futureKey: 1 }, newTopLevel: {} };
    const parsed = parseManifest(JSON.stringify(base));
    expect(parsed.gateway).toEqual({ digest: null, source: null, imageTag: null, repository: null });
    expect(parsed.code.pinnedSha).toEqual({ beta: null, production: null });
    expect(parsed.cloud.liveSha).toEqual({ beta: null, production: null });
    expect(() => parseManifest("nope")).toThrow(/not JSON/);
    expect(() => parseManifest(JSON.stringify({ ...base, schema: 2 }))).toThrow(/schema 1/);
    expect(() => parseManifest(JSON.stringify({ ...base, executionId: "" }))).toThrow(/executionId/);
    expect(() => parseManifest(JSON.stringify({ ...base, mode: "other" }))).toThrow(/mode/);
  });

  it("reads last-good tolerantly, and an unreadable record is an error, never 'none'", () => {
    expect(() => parseLastGood("not json")).toThrow(/not JSON/);
    expect(() => parseLastGood(JSON.stringify({ schema: 2 }))).toThrow(/schema 1/);
    expect(() => parseLastGood(JSON.stringify({ schema: 1, env: "beta" }))).toThrow(/missing required/);
    const m = parseManifest(JSON.stringify({ schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode: "release", cloud: { tag: "v1.0.0", sha: sha("a"), trunk: "t" }, gateway: { digest: DIGEST_A } }));
    expect(buildLastGood(m, "beta", [], null, new Date(0)).code.sha).toBeNull();
    m.gateway.digest = null;
    expect(() => buildLastGood(m, "beta", [], null, new Date(0))).toThrow(/no gateway digest/);
  });

  it("pins the summary lines and the exports (quotes are stripped so a sourced file cannot run anything)", () => {
    const m = parseManifest(JSON.stringify({ schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode: "release", cloud: { tag: "v1.0.0", sha: sha("a"), trunk: "t", liveSha: { beta: sha("9") } }, code: { sha: sha("c"), supersedes: { executionId: "99887766-0000", codeSha: sha("e") } }, gateway: { digest: DIGEST_A, source: "built" }, stages: { beta: { startedAt: "t", changeSets: [{ part: "web", stack: "s", noChanges: false, counts: { add: 0, modify: 3, remove: 0, replace: 1 } }, { part: "app", stack: "s2", noChanges: true, counts: { add: 0, modify: 0, remove: 0, replace: 0 } }], gates: [{ name: "g", phase: "preflight", result: "pass", skippedReason: null }, { name: "k", phase: "preflight", result: "skipped", skippedReason: "why" }] } } }));
    const text = renderSummary(buildSummary(m, "beta", m.stages.beta!));
    expect(text).toBe([
      "PROMOTION SUMMARY beta  execution 1a2b3c4d  mode release",
      `  Code   : sha ${"c".repeat(12)}  release=run  (pinned: none)`,
      `  Cloud  : v1.0.0 ${"a".repeat(12)}  (live: ${"9".repeat(12)})`,
      `  Gateway: ${DIGEST_A.slice(0, 19)}...  source=built`,
      "  Change sets: web  +0 ~3 -0 r1 | app  no changes",
      "  Gates  : pass g | skipped k (why)",
      `  NOTE   : this run supersedes execution 99887766, whose Code sha ${"e".repeat(12)} is not promoted`, "",
    ].join("\n"));
    m.cloud.tag = "v1.0.0'; rm -rf /; echo '";
    expect(renderExports(m, "beta")).toContain("export CLOUD_TAG='v1.0.0; rm -rf /; echo '");
    expect(renderExports(m, "beta").split("\n").every((l) => l === "" || /^export [A-Z_]+='[^']*'$/u.test(l))).toBe(true);
  });
});

describe("pipeline stage CLI: command line and exit codes", () => {
  const baseEnv = { EXEC_ID, AWS_REGION: "us-east-1", ROVARA_EXPECTED_DEPLOY_ACCOUNT: FAKE_ACCOUNT };
  // A pipeline run (a uuid execution id) gets its Code facts in CODE_CTX (L9b); a Preflight without it is refused.
  const ctxEnv = { ...baseEnv, CODE_CTX: `live:${sha("d")},target:none,supersedes:none,supersedesSha:none` };
  const run = (argv: string[], env: Record<string, string | undefined>, state = betaWorld(), extra: { gates?: Gate[] } = {}) => {
    const lines: string[] = [];
    const exit = main(argv, env, { config, switchesFile: fakeSwitches, gates: extra.gates ?? [integrity], requiredGates: { preflight: [], "change-sets": [], "gateway-live": [], "proof": [] }, makePorts: () => makePorts(state, argv[0] as PipelineEnv), out: (l) => lines.push(l) });
    return exit.then((code) => ({ code, lines, state }));
  };

  it("CLOUD_PROD=on is refused unless CLOUD_REF is an explicit release tag, before any port is used", async () => {
    const env = { ...ctxEnv, CLOUD_SOURCE_COMMIT: sha("3") };
    for (const ref of [undefined, "from-trigger", "latest", "cloud/next"]) {
      const r = await run(["beta", "preflight"], { ...env, CLOUD_PROD: "on", ...(ref === undefined ? {} : { CLOUD_REF: ref }) });
      expect(r.code).toBe(3);
      expect(r.lines.join("\n")).toMatch(/CLOUD_PROD=on needs CLOUD_REF set to a release tag/u);
      expect(r.state.calls).toEqual([]);
    }
    expect((await run(["beta", "preflight"], { ...env, CLOUD_PROD: "on", CLOUD_REF: "v0.13.9" })).code).toBe(0);
    expect((await run(["beta", "preflight"], { ...env, CLOUD_PROD: "off", CLOUD_REF: "from-trigger" })).code).toBe(0);
  });

  it("parses flags, rejects unknown ones and bad values, and prints usage for help", () => {
    expect(parseArgs(["beta", "preflight", "--adopt", "--cloud-ref", "v1.2.3"])).toEqual({ env: "beta", step: "preflight", flags: { adopt: true, "cloud-ref": "v1.2.3" } });
    expect(() => parseArgs(["beta", "preflight", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["beta", "preflight", "--cloud-ref"])).toThrow(/needs a value/);
    expect(() => parseArgs(["staging", "preflight"])).toThrow(/unknown environment/);
    expect(() => parseArgs(["beta", "deploy"])).toThrow(/unknown step/);
    expect(() => parseArgs(["beta"])).toThrow(/environment and a step/);
  });

  it("builds inputs from env vars, with flags winning, and refuses bad values", () => {
    const i = buildInputs({ "cloud-prod": "on" }, { ...baseEnv, CLOUD_PROD: "off", CODE_RELEASE: "skip", CODE_SHA: sha("c"), CODE_LIVE_FACTS: '{"a":"b","n":1}', PIPELINE_SUPERSEDES: `{"executionId":"x","codeSha":"${sha("e")}"}`, PIPELINE_ADOPT: "1", PIPELINE_WORK: "/w", ROVARA_EXPECTED_DEPLOY_ACCOUNT: FAKE_ACCOUNT }, new Date());
    expect(i).toMatchObject({ cloudProd: true, codeRelease: "skip", codeSha: sha("c"), codeLiveFacts: { a: "b" }, supersedes: { executionId: "x", codeSha: sha("e") }, adopt: true, expectedAccount: FAKE_ACCOUNT, workDir: "/w", outDir: "out", cloudRef: null, dryRun: false });
    expect(() => buildInputs({}, {}, new Date())).toThrow(/EXEC_ID is not set/);
    expect(() => buildInputs({}, { EXEC_ID: "bad id" }, new Date())).toThrow(/not a pipeline execution id/);
    expect(() => buildInputs({}, { ...baseEnv, ROVARA_EXPECTED_DEPLOY_ACCOUNT: "12345" }, new Date())).toThrow(/12-digit/);
    expect(() => buildInputs({}, { ...baseEnv, CODE_RELEASE: "maybe" }, new Date())).toThrow(/run or skip/);
    expect(() => buildInputs({}, { ...baseEnv, CODE_SHA: "abc" }, new Date())).toThrow(/40-hex/);
    expect(() => buildInputs({}, { ...baseEnv, CODE_LIVE_FACTS: "[" }, new Date())).toThrow(/not JSON/);
    expect(buildInputs({}, { EXEC_ID: "local-test1" }, new Date()).execId).toBe("local-test1");
  });

  it("exits 2 on usage errors and 0 on help", async () => {
    expect((await run(["beta", "nope"], baseEnv)).code).toBe(2);
    expect((await run(["beta", "preflight", "--help"], ctxEnv)).code).toBe(0);
    expect((await run(["beta", "preflight"], {})).code).toBe(2);
  });

  it("exits 3 with a STAGE-FAILED line for the wrong region, and 40 for a missing tag", async () => {
    const wrong = await run(["beta", "preflight"], { ...ctxEnv, AWS_REGION: "eu-west-1" });
    expect(wrong.code).toBe(3);
    expect(wrong.lines.at(-1)).toMatch(/^STAGE-FAILED beta preflight REFUSED: AWS_REGION is eu-west-1/);
    const noTag = await run(["beta", "preflight"], ctxEnv, betaWorld({ tags: {} }));
    expect(noTag.code).toBe(40);
    expect(noTag.lines.at(-1)).toMatch(/^STAGE-FAILED beta preflight REF_FAILED/);
  });

  it("exits 42 for a release run in an environment that has never been adopted", async () => {
    const state = betaWorld();
    state.ssm = {};
    const refused = await run(["beta", "preflight"], ctxEnv, state);
    expect(refused.code).toBe(42);
    expect(refused.lines.at(-1)).toMatch(/^STAGE-FAILED beta preflight ADOPTION_REQUIRED: beta has no last-good record/);
  });

  it("exits 20 when a gate fails, 3 for an image step with no repository, 0 for a good preflight", async () => {
    const bad: Gate = { name: "bad", phases: ["preflight"], run: () => Promise.resolve({ result: "fail", failures: ["x"] }) };
    expect((await run(["beta", "preflight"], ctxEnv, betaWorld(), { gates: [integrity, bad] })).code).toBe(20);
    const state = betaWorld();
    const good = await run(["beta", "preflight"], ctxEnv, state);
    expect(good.code).toBe(0);
    state.files["/in/manifest.json"] = state.files["out/manifest.json"]!;
    const image = await run(["beta", "image", "--manifest", "/in/manifest.json"], ctxEnv, state);
    expect(image.code).toBe(3);
    expect(image.lines.at(-1)).toMatch(/^STAGE-FAILED beta image REFUSED: the stack rovara-cloud-beta-gateway-images does not exist/);
  });

  it("ref prints the resolution without writing, last-good prints the record or none, summary re-prints", async () => {
    const state = betaWorld();
    const ref = await run(["beta", "ref"], ctxEnv, state);
    expect(ref.code).toBe(0);
    expect(JSON.parse(ref.lines.join("\n"))).toMatchObject({ env: "beta", cloud: { tag: "v0.13.10" }, mode: "release", lastGoodParameter: "/rovara-cloud/beta/release/last-good" });
    expect(Object.keys(state.files)).toEqual([]);
    state.ssm = {};
    expect((await run(["beta", "last-good"], baseEnv, state)).lines).toEqual(["none"]);
    state.ssm["/rovara-cloud/beta/release/last-good"] = "garbage";
    expect((await run(["beta", "last-good"], baseEnv, state)).code).toBe(3);
    seedLastGood(state, "beta");
    await run(["beta", "preflight"], ctxEnv, state);
    state.files["/in/manifest.json"] = state.files["out/manifest.json"]!;
    const summary = await run(["beta", "summary", "--manifest", "/in/manifest.json"], baseEnv, state);
    expect(summary.lines[0]).toMatch(/^PROMOTION SUMMARY beta/);
  });
});
