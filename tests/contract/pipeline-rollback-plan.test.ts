// L9: the rollback plan, the rollback run's own rules (floor in the flow, recorded digest, forced skip and pin) and last-good (moves only after the proofs). Fakes only.
import { describe, expect, it } from "vitest";
import { gate as floorGate } from "../../ops/pipeline/gates/rollback-floor.gate.ts";
import { gate as integrity } from "../../ops/pipeline/gates/change-set-integrity.gate.ts";
import { FLOORS_PATH } from "../../ops/pipeline/lib/floors.ts";
import { parseLastGood } from "../../ops/pipeline/lib/lastgood.ts";
import { parseManifest } from "../../ops/pipeline/lib/manifest.ts";
import { planRollback } from "../../ops/pipeline/lib/rollbackplan.ts";
import { runStep } from "../../ops/pipeline/lib/run.ts";
import type { StepFunction } from "../../ops/pipeline/lib/run.ts";
import { main } from "../../ops/pipeline/stage.ts";
import { gatewayCheckStep } from "../../ops/pipeline/steps/gateway-check.ts";
import { gatewayStep } from "../../ops/pipeline/steps/gateway.ts";
import { imageStep } from "../../ops/pipeline/steps/image-step.ts";
import { preflight } from "../../ops/pipeline/steps/preflight.ts";
import { proofStep } from "../../ops/pipeline/steps/proof.ts";
import { webAppStep } from "../../ops/pipeline/steps/web-app.ts";
import type { Gate, ImageStepResult, PipelineEnv, StepName } from "../../ops/pipeline/types.ts";
import type { Inputs } from "../../ops/pipeline/lib/context.ts";
import { withCodeClone, CDK_METADATA, DIGEST_A, DIGEST_B, EXEC_ID, FAKE_ACCOUNT, MODIFY_FUNCTION, config, fakeSwitches, liveStack, makeCtx, makePorts, newState, row, sha, stackFor } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

const LAST_GOOD = "/rovara-cloud/beta/release/last-good";
const FLOORS = JSON.stringify({ schema: 1, floors: { web: [{ sha: sha("1"), reason: "web train one" }] }, gatewayDigests: { belowFloor: [{ digest: `sha256:${"c".repeat(64)}`, reason: "no price bands" }] } });
const record = (over: Record<string, unknown> = {}): string => JSON.stringify({
  schema: 1, env: "beta", recordedAt: "2026-11-24T10:00:00.000Z", executionId: "aaaabbbb-0000-4000-8000-000000000000", mode: "release",
  cloud: { tag: "v0.13.9", sha: sha("3") }, gateway: { digest: DIGEST_A, codeSha: sha("c") }, code: { sha: sha("c") }, proofGates: ["healthz"],
  previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_B, gatewayCodeSha: sha("b") }, ...over,
});

/** Beta runs v0.13.10 (sha 4); last-good is v0.13.9; the floors file is in the pipeline tree. */
function world(over: Partial<FakeState> = {}, lastGood: string | null = record(), floors: string | null = FLOORS): FakeState {
  const state = newState({
    exec: withCodeClone(),
    plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION], RovaraModelGateway: [row("Modify", "TaskDef", "AWS::ECS::TaskDefinition", "True")] },
    ssm: lastGood === null ? {} : { [LAST_GOOD]: lastGood },
    files: floors === null ? {} : { [`/pipeline/${FLOORS_PATH}`]: floors, [`${process.cwd()}/${FLOORS_PATH}`]: floors },
    ...over,
  });
  liveStack(state, stackFor("beta", "gateway"), { parameters: { ImageDigest: DIGEST_B } });
  liveStack(state, stackFor("beta", "web"), { outputs: { CloudUrl: "https://cloud.example.test/app", DeployedCloudSha: sha("4") } });
  liveStack(state, stackFor("beta", "app"));
  return state;
}
const plan = (state: FakeState, which: "last-good" | "previous" = "last-good", codeLiveSha: string | null = null): Promise<string[]> =>
  planRollback({ ports: makePorts(state), config, env: "beta", which, codeLiveSha, pipelineDir: "/pipeline" });
const refuses = async (promise: Promise<unknown>, exitName: string, text: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  await expect(promise).rejects.toThrow(text);
};

describe("rollback-plan: which release and which variables", () => {
  it("plans the last-good release: ref, forced Code skip, recorded gateway digest, the pin placeholder, floors checked", async () => {
    const lines = await plan(world());
    expect(lines).toEqual([
      "ROLLBACK PLAN beta  (read-only: nothing was changed)",
      `  Live   : v0.13.10 ${sha("4").slice(0, 12)}`,
      `  Target : v0.13.9 ${sha("3").slice(0, 12)}  (last-good, recorded 2026-11-24T10:00:00.000Z by execution aaaabbbb, mode release)`,
      `  Gateway: ${DIGEST_A}  (built from Code ${sha("c").slice(0, 12)})`,
      "  Floors : 1 checked, none below",
      "  Run the pipeline with these variables (beta first, then production, each with its own CODE_LIVE_SHA):",
      "    CLOUD_REF=v0.13.9",
      "    CODE_RELEASE=skip",
      `    GATEWAY_DIGEST=${DIGEST_A}`,
      "    CODE_LIVE_SHA=<the Code sha live in beta>",
      "  NOTE   : Code is skipped and pinned to the sha live in this environment; approving this run never promotes unreviewed Code",
    ]);
    expect((await plan(world(), "last-good", sha("d"))).join("\n")).toContain(`CODE_LIVE_SHA=${sha("d")}`);
  });

  it("plans the previous release only when asked, with the digest recorded for it", async () => {
    const lines = await plan(world(), "previous");
    expect(lines.join("\n")).toMatch(/Target : v0\.13\.2 .*previous of the last-good/u);
    expect(lines).toContain(`    GATEWAY_DIGEST=${DIGEST_B}`);
  });

  it("refuses when there is no last-good, and never falls back to a guess (exit 41)", async () => {
    await refuses(plan(world({}, null)), "ROLLBACK_REFUSED", /no last-good record/);
  });

  it("an unreadable last-good is an error (exit 3), not 'none' and not an older record (rule 9)", async () => {
    await refuses(plan(world({}, "garbage")), "REFUSED", /not JSON/);
    await refuses(plan(world({}, JSON.stringify({ schema: 1, env: "beta" }))), "REFUSED", /missing required/);
  });

  it("refuses a target that is already live, pointing at --target previous", async () => {
    await refuses(plan(world({}, record({ cloud: { tag: "v0.13.10", sha: sha("4") } }))), "ROLLBACK_REFUSED", /already what beta runs.*--target previous/u);
  });

  it("never offers the record a rollback run rolled away from", async () => {
    await refuses(plan(world({}, record({ mode: "rollback" })), "previous"), "ROLLBACK_REFUSED", /rolled away from/);
    await refuses(plan(world({}, record({ previous: null })), "previous"), "ROLLBACK_REFUSED", /no previous record/);
    await refuses(plan(world({}, record({ previous: { cloudTag: "v0.13.2", cloudSha: sha("2") } })), "previous"), "ROLLBACK_REFUSED", /no gateway digest/);
  });

  it("refuses a target below a floor with the floor's reason, and a digest the file lists below the floor", async () => {
    const floors = JSON.stringify({ schema: 1, floors: { web: [{ sha: sha("3"), reason: "web train three" }] } });
    await refuses(plan(world({}, record(), floors), "previous"), "ROLLBACK_REFUSED", /below the web floor.*web train three/u);
    await refuses(plan(world({}, record({ gateway: { digest: `sha256:${"c".repeat(64)}`, codeSha: sha("c") } }))), "ROLLBACK_REFUSED", /no price bands/);
  });

  it("names the Code commit the target gateway was built from, and refuses a target whose gateway has none recorded (an image from before the gateway moved to Code)", async () => {
    expect((await plan(world(), "previous")).join("\n")).toContain(`Gateway: ${DIGEST_B}  (built from Code ${sha("b").slice(0, 12)})`);
    await refuses(plan(world({}, record({ previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_B } })), "previous"), "ROLLBACK_REFUSED", /no Code commit for it.*recorded before the gateway moved to Code/u);
    await refuses(plan(world({}, record({ gateway: { digest: DIGEST_A } }))), "ROLLBACK_REFUSED", /no Code commit for it/u);
  });

  it("judges the target gateway's Code commit against the gatewayCode floors in the Code clone, and says when the plan was made without a clone", async () => {
    const floors = JSON.stringify({ schema: 1, floors: { gatewayCode: [{ sha: sha("e"), reason: "gateway needs the e commit" }] } });
    const below = world({ exec: withCodeClone((cmd, args) => (cmd === "git" && args.includes("merge-base") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" })) }, record(), floors);
    await refuses(plan(below), "ROLLBACK_REFUSED", /below the gatewayCode floor eeeeeeeeeeee: gateway needs the e commit/u);
    const above = world({ exec: withCodeClone() }, record(), floors);
    expect((await plan(above)).join("\n")).not.toMatch(/WARN/u);
    const noClone = world({ exec: () => ({ code: 0, stdout: "", stderr: "" }) }, record(), floors);
    expect((await plan(noClone)).join("\n")).toMatch(/WARN {3}: the gateway's Code commit was not judged against the 1 gatewayCode floor\(s\): no Code clone/u);
  });

  it("refuses when the floors file is missing (never 'no floors')", async () => {
    await refuses(plan(world({}, record(), null)), "ROLLBACK_REFUSED", /missing from the pipeline tree/);
  });

  it("refuses a tag that moved, a tag off the trunk (exit 40) and a target that is not older than live", async () => {
    await refuses(plan(world({ tags: { "v0.13.9": sha("2"), "v0.13.10": sha("4") } })), "ROLLBACK_REFUSED", /must not move/);
    await refuses(plan(world({}, record({ cloud: { tag: "v0.14.0", sha: sha("9") } }))), "REF_FAILED", /not on cloud\/next/);
    const state = world();
    state.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("2");
    await refuses(plan(state), "ROLLBACK_REFUSED", /not older than what beta runs/);
  });

  it("warns, and still plans, when the live sha is unknown or the target was recorded without a proof", async () => {
    const state = world({}, record({ proofSkipped: ["canary"] }));
    delete state.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha;
    const lines = (await plan(state)).join("\n");
    expect(lines).toMatch(/Live {3}: unknown/u);
    expect(lines).toMatch(/WARN {3}: no DeployedCloudSha output/u);
    expect(lines).toMatch(/WARN {3}: the target was recorded without proof from: canary/u);
  });

  it("is a read-only CLI step: exit 0 with the plan, 41 on a refusal, 2 for a bad --target", async () => {
    const env = { EXEC_ID, AWS_REGION: "us-east-1", ROVARA_EXPECTED_DEPLOY_ACCOUNT: FAKE_ACCOUNT };
    const go = async (argv: string[], state: FakeState) => {
      const lines: string[] = [];
      const code = await main(argv, env, { config, switchesFile: fakeSwitches, gates: [], requiredGates: { preflight: [], "change-sets": [], "gateway-live": [], proof: [] }, makePorts: () => makePorts(state, argv[0] as PipelineEnv), out: (l) => lines.push(l) });
      return { code, lines, state };
    };
    const ok = await go(["beta", "rollback-plan"], world());
    expect(ok.code).toBe(0);
    expect(ok.lines[0]).toBe("ROLLBACK PLAN beta  (read-only: nothing was changed)");
    expect(Object.keys(ok.state.files).filter((f) => f.startsWith("out"))).toEqual([]);
    expect(ok.state.calls.filter((c) => c.startsWith("ssm put") || c.startsWith("cfn execute"))).toEqual([]);
    const previous = await go(["beta", "rollback-plan", "--target", "previous", "--code-live-sha", sha("d")], world());
    expect(previous.lines.join("\n")).toContain(`CODE_LIVE_SHA=${sha("d")}`);
    const refused = await go(["beta", "rollback-plan"], world({}, null));
    expect(refused.code).toBe(41);
    expect(refused.lines.at(-1)).toMatch(/^STAGE-FAILED beta rollback-plan ROLLBACK_REFUSED: beta has no last-good record/u);
    expect((await go(["beta", "rollback-plan", "--target", "oldest"], world())).code).toBe(2);
  });
});

// ---- the rollback run through the steps ----

const okImage = (digest: string) => (): Promise<ImageStepResult> => Promise.resolve({ digest, source: "supplied", imageTag: "t", repository: "r" });
const pass = (name: string, phase: Gate["phases"][number]): Gate => ({ name, phases: [phase], run: () => Promise.resolve({ result: "pass" }) });
const STEPS: Record<StepName, StepFunction> = {
  preflight, image: (c, s) => imageStep(c, s, okImage(DIGEST_A)), gateway: gatewayStep, "gateway-check": gatewayCheckStep, "web-app": webAppStep, proof: proofStep,
};
interface Run { state: FakeState; gates: Gate[]; inputs: Partial<Inputs> }
async function step(run: Run, name: StepName, inputs: Partial<Inputs> = {}): Promise<void> {
  const previous = run.state.files["out/manifest.json"];
  if (previous !== undefined) run.state.files["/in/manifest.json"] = previous;
  const ctx = makeCtx(run.state, "beta", name, {
    inputs: { manifestPath: previous === undefined ? null : "/in/manifest.json", ...run.inputs, ...inputs }, gates: run.gates,
    required: { preflight: ["rollback-floor"], "change-sets": ["change-set-integrity", "rollback-floor"], "gateway-live": [], proof: [] },
  });
  await runStep(ctx, STEPS[name]);
}
const ROLLBACK_INPUTS: Partial<Inputs> = { cloudRef: "v0.13.9", codeLiveSha: sha("d") };
const lastGoodOf = (state: FakeState) => parseLastGood(state.ssm[LAST_GOOD]!);

describe("a rollback run", () => {
  it("forces Code to skip and pins it, runs the floor gate in preflight and with the gateway change set, and needs the recorded digest", async () => {
    const run: Run = { state: world(), gates: [integrity, floorGate, pass("g2", "gateway-live"), pass("healthz", "proof")], inputs: ROLLBACK_INPUTS };
    await step(run, "preflight");
    const m = parseManifest(run.state.files["out/manifest.json"]!);
    expect(m).toMatchObject({ mode: "rollback", code: { release: "skip", pinnedSha: { beta: sha("d") } } });
    expect(run.state.files["out/exports.env"]).toContain("export CODE_RELEASE_EFFECTIVE='skip'");
    expect(m.stages.beta!.gates.filter((g) => g.name === "rollback-floor").map((g) => [g.phase, g.result])).toEqual([["preflight", "pass"], ["change-sets", "skipped"]]);
    // without GATEWAY_DIGEST the image step refuses; it never builds an image from old source
    await expect(step(run, "image")).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED" });
    await step(run, "image", { gatewayDigest: DIGEST_A });
    await step(run, "gateway", { gatewayDigest: DIGEST_A });
    expect(parseManifest(run.state.files["out/manifest.json"]!).stages.beta!.gates.filter((g) => g.name === "rollback-floor").map((g) => `${g.scope}:${g.result}`).sort()).toEqual(["app+web:skipped", "gateway:pass", "null:pass"]);
  });

  it("only a digest the environment's last-good record names (current or previous) is accepted; an unrecorded one is refused, even one that exists", async () => {
    const unrecorded = `sha256:${"e".repeat(64)}`;
    const fresh = async (digest: string, over: Partial<Inputs> = {}): Promise<Run> => {
      const run: Run = { state: world(), gates: [integrity, floorGate], inputs: ROLLBACK_INPUTS };
      await step(run, "preflight");
      await step(run, "image", { gatewayDigest: digest, ...over });
      return run;
    };
    // current and previous records pass (the image function is a fake that echoes what it is given)
    for (const digest of [DIGEST_A, DIGEST_B]) {
      const run: Run = { state: world(), gates: [integrity, floorGate], inputs: ROLLBACK_INPUTS };
      await step(run, "preflight");
      run.state.files["/in/manifest.json"] = run.state.files["out/manifest.json"]!;
      await runStep(makeCtx(run.state, "beta", "image", { inputs: { manifestPath: "/in/manifest.json", ...ROLLBACK_INPUTS, gatewayDigest: digest }, gates: run.gates }), (c, s) => imageStep(c, s, okImage(digest)));
      expect(parseManifest(run.state.files["out/manifest.json"]!).gateway.digest).toBe(digest);
    }
    // an unrecorded digest is refused before the image function is called, and the manifest keeps no digest
    const refused = fresh(unrecorded);
    await expect(refused).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED" });
    await expect(refused).rejects.toThrow(/not one the beta last-good record names/);
    // no last-good record at all: refused too
    // (L2 refuses such a run already in preflight with exit 42; the image step's own refusal is reached by removing the record after preflight)
    const none: Run = { state: world(), gates: [integrity, floorGate], inputs: ROLLBACK_INPUTS };
    await step(none, "preflight");
    delete none.state.ssm[LAST_GOOD];
    await expect(step(none, "image", { gatewayDigest: DIGEST_A })).rejects.toThrow(/there is no last-good record/);
    await expect(step({ state: world({}, null), gates: [integrity, floorGate], inputs: ROLLBACK_INPUTS }, "preflight")).rejects.toMatchObject({ exitName: "ADOPTION_REQUIRED" });
    // the digest rollback-plan prints is accepted
    const printed = (await plan(world())).find((l) => l.startsWith("    GATEWAY_DIGEST="))!.slice("    GATEWAY_DIGEST=".length);
    const ok = await fresh(printed);
    expect(parseManifest(ok.state.files["out/manifest.json"]!).gateway.digest).toBe(DIGEST_A);
  });

  it("is refused in preflight when the ref is below a floor, before any change set is created", async () => {
    const run: Run = { state: world({}, record(), JSON.stringify({ schema: 1, floors: { web: [{ sha: sha("3"), reason: "web train three" }] } })), gates: [integrity, floorGate], inputs: { cloudRef: "v0.13.2", codeLiveSha: sha("d") } };
    await expect(step(run, "preflight")).rejects.toMatchObject({ exitName: "GATE_FAILED" });
    expect(run.state.calls.some((c) => c.startsWith("cdk "))).toBe(false);
    expect(JSON.parse(run.state.files["out/gates/preflight-rollback-floor.json"]!)).toMatchObject({ result: "fail", failures: [expect.stringMatching(/web train three/u)] });
  });

  it("is refused in the gateway step when the supplied digest is one the file lists below the floor", async () => {
    const below = `sha256:${"c".repeat(64)}`;
    const run: Run = { state: world({}, record({ previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: below, gatewayCodeSha: sha("b") } })), gates: [integrity, floorGate], inputs: ROLLBACK_INPUTS };
    run.state.plan = { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION], RovaraModelGateway: [row("Modify", "TaskDef", "AWS::ECS::TaskDefinition", "True")] };
    await step(run, "preflight");
    const ctxSteps: Record<string, StepFunction> = { ...STEPS, image: (c, s) => imageStep(c, s, okImage(below)) };
    const previous = run.state.files["out/manifest.json"]!;
    run.state.files["/in/manifest.json"] = previous;
    await runStep(makeCtx(run.state, "beta", "image", { inputs: { manifestPath: "/in/manifest.json", ...ROLLBACK_INPUTS, gatewayDigest: below }, gates: run.gates }), ctxSteps.image!);
    run.state.files["/in/manifest.json"] = run.state.files["out/manifest.json"]!;
    await expect(runStep(makeCtx(run.state, "beta", "gateway", { inputs: { manifestPath: "/in/manifest.json", ...ROLLBACK_INPUTS, gatewayDigest: below }, gates: run.gates }), gatewayStep)).rejects.toMatchObject({ exitName: "GATE_FAILED" });
    expect(run.state.calls.filter((c) => c.startsWith("cfn execute"))).toEqual([]);
  });

  it("writes last-good as a rollback record after its proofs pass, with the replaced record as previous", async () => {
    const run: Run = { state: world(), gates: [integrity, floorGate, pass("g2", "gateway-live"), pass("healthz", "proof")], inputs: ROLLBACK_INPUTS };
    for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as StepName[]) await step(run, name, name === "image" || name === "gateway" ? { gatewayDigest: DIGEST_A } : {});
    expect(lastGoodOf(run.state)).toMatchObject({ mode: "rollback", cloud: { tag: "v0.13.9" }, gateway: { digest: DIGEST_A }, code: { sha: sha("d") }, proofGates: ["healthz"], previous: { cloudTag: "v0.13.9", cloudSha: sha("3") } });
  });
});

describe("last-good moves only after the proofs", () => {
  const upTo = async (run: Run): Promise<void> => { for (const name of ["preflight", "image", "gateway", "gateway-check", "web-app"] as StepName[]) await step(run, name); };
  const unproven = (hold: boolean): Gate => ({ name: "canary", phases: ["proof"], run: () => Promise.resolve({ result: "skipped", skippedReason: "the lane was busy", data: hold ? { holdsLastGood: true } : {} }) });

  it("a failing proof gate leaves the record untouched", async () => {
    const run: Run = { state: world({}, record()), gates: [integrity, floorGate, { name: "bad", phases: ["proof"], run: () => Promise.resolve({ result: "fail", failures: ["no"] }) }], inputs: {} };
    await upTo(run);
    await expect(step(run, "proof")).rejects.toMatchObject({ exitName: "GATE_FAILED" });
    expect(run.state.ssm[LAST_GOOD]).toBe(record());
  });

  it("a proof gate that gave no proof either way keeps last-good where it was and says so in the summary", async () => {
    const run: Run = { state: world({}, record()), gates: [integrity, floorGate, pass("healthz", "proof"), unproven(true)], inputs: {} };
    await upTo(run);
    await step(run, "proof");
    expect(run.state.ssm[LAST_GOOD]).toBe(record());
    expect(run.state.calls.some((c) => c.startsWith("ssm put"))).toBe(false);
    expect(run.state.files["out/summary.txt"]).toMatch(/WARN {3}: last-good \(beta\) did NOT move: canary gave no proof either way \(the lane was busy\)/u);
    expect(parseManifest(run.state.files["out/manifest.json"]!).stages.beta!.completed).toContain("proof");
  });

  it("an unreadable current record is refused even when last-good would not move (rule 9)", async () => {
    const run: Run = { state: world({}, record()), gates: [integrity, floorGate, unproven(true)], inputs: {} };
    await upTo(run);
    run.state.ssm[LAST_GOOD] = "garbage"; // L2's preflight now reads the record first, so it is corrupted after the earlier steps
    await expect(step(run, "proof")).rejects.toMatchObject({ exitName: "REFUSED" });
  });

  it("a skipped proof gate that holds nothing is recorded in proofSkipped; a record without it still reads", async () => {
    const run: Run = { state: world({}, record()), gates: [integrity, floorGate, pass("healthz", "proof"), unproven(false)], inputs: {} };
    await upTo(run);
    await step(run, "proof");
    expect(lastGoodOf(run.state)).toMatchObject({ proofGates: ["healthz"], proofSkipped: ["canary"] });
    expect(parseLastGood(record()).proofSkipped).toBeUndefined();
    expect(parseLastGood(record({ proofSkipped: ["a", 3] })).proofSkipped).toEqual(["a"]);
  });
});
