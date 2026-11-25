// L9b Cloud part: the pipeline-driven Code rollback in the stage CLI. CODE_CTX (parsed strictly, carried in the manifest), PIPELINE_MODE=rollback, a Code target
// that keeps Code releasing (CODE_RELEASE_EFFECTIVE=run, the pin is the target), the `code` floors group judged in the Code clone, rollback-plan --code-target,
// and supersession. Fakes only: no AWS, no network, no real git.
import { describe, expect, it } from "vitest";
import { gate as floorGate } from "../../ops/pipeline/gates/rollback-floor.gate.ts";
import { gate as integrity } from "../../ops/pipeline/gates/change-set-integrity.gate.ts";
import { gate as drift } from "../../ops/pipeline/gates/deployed-drift.gate.ts";
import { parseCodeCtx } from "../../ops/pipeline/lib/codectx.ts";
import { FLOORS_PATH, parseFloors } from "../../ops/pipeline/lib/floors.ts";
import { codeShaThatWillBeLive } from "../../ops/pipeline/lib/gate-env.ts";
import { buildLastGood } from "../../ops/pipeline/lib/lastgood.ts";
import { parseManifest } from "../../ops/pipeline/lib/manifest.ts";
import { decideMode } from "../../ops/pipeline/lib/refs.ts";
import { planRollback } from "../../ops/pipeline/lib/rollbackplan.ts";
import { runStep } from "../../ops/pipeline/lib/run.ts";
import type { StepFunction } from "../../ops/pipeline/lib/run.ts";
import { buildSummary, renderExports, renderSummary } from "../../ops/pipeline/lib/summary.ts";
import { buildInputs, main } from "../../ops/pipeline/stage.ts";
import { gatewayCheckStep } from "../../ops/pipeline/steps/gateway-check.ts";
import { gatewayStep } from "../../ops/pipeline/steps/gateway.ts";
import { imageStep } from "../../ops/pipeline/steps/image-step.ts";
import { preflight } from "../../ops/pipeline/steps/preflight.ts";
import { proofStep } from "../../ops/pipeline/steps/proof.ts";
import { webAppStep } from "../../ops/pipeline/steps/web-app.ts";
import type { ExecResult, Gate, GateInput, ImageStepResult, Manifest, PipelineEnv, StepName } from "../../ops/pipeline/types.ts";
import type { Inputs } from "../../ops/pipeline/lib/context.ts";
import { CDK_METADATA, DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, FAKE_ACCOUNT, MODIFY_FUNCTION, config, fakeSwitches, liveStack, makeCtx, makePorts, newState, row, seedLastGood, sha, stackFor } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

// Code history of the fake clone, oldest first: FLOOR < OLD < MID < LIVE.
const [FLOOR, OLD, MID, LIVE] = [sha("1"), sha("2"), sha("3"), sha("d")];
const CODE_HISTORY = [FLOOR, OLD, MID, LIVE];
const WAITING = "99887766-aaaa-4bbb-8ccc-444455556666";
const ctxValue = (over: { live?: string; target?: string | null; supersedes?: string | null; supersedesSha?: string | null } = {}): string =>
  `live:${over.live ?? LIVE},target:${over.target ?? "none"},supersedes:${over.supersedes ?? "none"},supersedesSha:${over.supersedesSha ?? "none"}`;

describe("CODE_CTX: parsed strictly", () => {
  it("reads the four parts, with none for an absent target and supersession", () => {
    expect(parseCodeCtx(ctxValue())).toEqual({ live: LIVE, target: null, supersedes: null, trigger: null });
    expect(parseCodeCtx(ctxValue({ target: OLD, supersedes: WAITING, supersedesSha: MID }))).toEqual({ live: LIVE, target: OLD, supersedes: { executionId: WAITING, codeSha: MID }, trigger: null });
    expect(parseCodeCtx(ctxValue({ supersedes: WAITING }))).toEqual({ live: LIVE, target: null, supersedes: { executionId: WAITING, codeSha: null }, trigger: null });
  });

  it("refuses every malformed value (exit 3), never guessing a part", () => {
    const good = ctxValue({ target: OLD, supersedes: WAITING, supersedesSha: MID });
    const bad = [
      "", " ", good + ",", good + ",extra:1", `${good} `, ` ${good}`, `${good}\n`, good.replace("live:", "Live:"), good.replace("live:", "live="),
      `target:${OLD},live:${LIVE},supersedes:none,supersedesSha:none`, // wrong order
      `live:${LIVE},target:${OLD},supersedes:none`, // a missing part
      ctxValue({ live: LIVE.toUpperCase() }), ctxValue({ live: LIVE.slice(1) }), ctxValue({ live: "none" }), ctxValue({ target: OLD.slice(0, 12) }), ctxValue({ target: "None" }),
      ctxValue({ supersedes: "not-a-uuid" }), ctxValue({ supersedes: WAITING.toUpperCase() }), ctxValue({ supersedes: WAITING, supersedesSha: "abc" }),
      ctxValue({ supersedesSha: MID }), // a commit without the execution that holds it
      `live:${LIVE},target:none,supersedes:none,supersedesSha:none,`, `live:${LIVE};target:none;supersedes:none;supersedesSha:none`,
      ctxValue({ target: `${OLD}'; rm -rf /; echo '`.slice(0, 40) + "x" }),
    ];
    for (const value of bad) expect(() => parseCodeCtx(value), JSON.stringify(value)).toThrow(expect.objectContaining({ exitName: "REFUSED", message: expect.stringMatching(/^CODE_CTX is malformed/u) as string }) as Error);
  });

  it("buildInputs takes live, target and supersession from CODE_CTX alone; a malformed one refuses the whole run", () => {
    const base = { EXEC_ID, AWS_REGION: "us-east-1", PIPELINE_MODE: "rollback" };
    const i = buildInputs({}, { ...base, CODE_CTX: ctxValue({ target: OLD, supersedes: WAITING, supersedesSha: MID }) }, new Date());
    expect(i).toMatchObject({ codeLiveSha: LIVE, codeTarget: OLD, supersedes: { executionId: WAITING, codeSha: MID }, declaredRollback: true, codeCtxGiven: true });
    expect(buildInputs({}, { ...base }, new Date())).toMatchObject({ codeLiveSha: null, codeTarget: null, supersedes: null, codeCtxGiven: false });
    expect(() => buildInputs({}, { ...base, CODE_CTX: "live:abc" }, new Date())).toThrow(/CODE_CTX is malformed/);
    // a hand variable beside CODE_CTX may only say the same thing
    const withCtx = { ...base, CODE_CTX: ctxValue({ target: OLD }) };
    expect(buildInputs({}, { ...withCtx, CODE_LIVE_SHA: LIVE, CODE_ROLLBACK_TARGET: OLD }, new Date()).codeTarget).toBe(OLD);
    expect(() => buildInputs({}, { ...withCtx, CODE_LIVE_SHA: MID }, new Date())).toThrow(/CODE_LIVE_SHA contradicts CODE_CTX/);
    expect(() => buildInputs({}, { ...withCtx, CODE_ROLLBACK_TARGET: MID }, new Date())).toThrow(/CODE_ROLLBACK_TARGET contradicts CODE_CTX/);
    expect(() => buildInputs({}, { ...withCtx, CODE_ROLLBACK_TARGET: "none" }, new Date())).toThrow(/contradicts CODE_CTX/);
    expect(() => buildInputs({}, { ...withCtx, PIPELINE_SUPERSEDES: `{"executionId":"${WAITING}"}` }, new Date())).toThrow(/PIPELINE_SUPERSEDES contradicts CODE_CTX/);
    // hand-started: the variables stand alone, and a target must be a full sha or none
    expect(buildInputs({}, { ...base, CODE_LIVE_SHA: LIVE, CODE_ROLLBACK_TARGET: OLD }, new Date())).toMatchObject({ codeLiveSha: LIVE, codeTarget: OLD, codeCtxGiven: false });
    expect(buildInputs({}, { ...base, CODE_ROLLBACK_TARGET: "none" }, new Date()).codeTarget).toBeNull();
    expect(() => buildInputs({}, { ...base, CODE_ROLLBACK_TARGET: "abc" }, new Date())).toThrow(/40-hex/);
    expect(buildInputs({ "code-target": OLD }, { ...base }, new Date()).codeTarget).toBe(OLD);
  });

  it("a malformed CODE_CTX exits 3 from the command line, before any AWS call", async () => {
    const lines: string[] = [];
    const state = newState();
    const code = await main(["beta", "preflight"], { EXEC_ID, AWS_REGION: "us-east-1", ROVARA_EXPECTED_DEPLOY_ACCOUNT: FAKE_ACCOUNT, CODE_CTX: `live:${LIVE}` }, {
      config, switchesFile: fakeSwitches, gates: [], requiredGates: { preflight: [], "change-sets": [], "gateway-live": [], proof: [] }, makePorts: () => makePorts(state), out: (l) => { lines.push(l); },
    });
    expect(code).toBe(3);
    expect(lines.at(-1)).toMatch(/^STAGE-FAILED beta preflight REFUSED: CODE_CTX is malformed/u);
    expect(state.calls).toEqual([]);
  });
});

const STEPS: Record<StepName, StepFunction> = {
  preflight, image: (c, s) => imageStep(c, s, () => Promise.resolve({ digest: DIGEST_A, source: "built", imageTag: `pipe-${EXEC8}-abc`, repository: "images" } satisfies ImageStepResult)),
  gateway: gatewayStep, "gateway-check": gatewayCheckStep, "web-app": webAppStep, proof: proofStep,
};

/**
 * Beta and production both run v0.13.10 (sha 4); the Code clone is a fake: ROVARA_CODE_REPO names it, `git -C` answers from CODE_HISTORY.
 * `clone: false` = the build action gave no Code clone.
 */
function codeExec(clone = true, known: readonly string[] = CODE_HISTORY): (cmd: string, args: readonly string[]) => ExecResult {
  const ok = (code = 0, stdout = ""): ExecResult => ({ code, stdout, stderr: "" });
  return (cmd, args) => {
    if (cmd === "printenv") return args[0] === "ROVARA_CODE_REPO" && clone ? ok(0, "/code\n") : ok(1);
    if (cmd === "git" && args[0] === "-C") {
      if (args[1] !== "/code") return ok(128);
      if (args[2] === "cat-file") return known.includes(args[4]!.replace("^{commit}", "")) ? ok() : ok(1);
      if (args[2] === "merge-base") {
        const [a, d] = [CODE_HISTORY.indexOf(args[4]!), CODE_HISTORY.indexOf(args[5]!)];
        return a < 0 || d < 0 ? ok(128) : ok(a <= d ? 0 : 1);
      }
    }
    return ok();
  };
}
const CODE_FLOORS = JSON.stringify({ schema: 1, floors: { code: [{ sha: OLD, reason: "Code before the second train sends a payload Cloud no longer reads" }], web: [{ sha: sha("1"), reason: "web train one" }] } });

function world(over: Partial<FakeState> = {}, env: PipelineEnv = "beta"): FakeState {
  const state = newState({
    plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION], RovaraModelGateway: [row("Modify", "TaskDef", "AWS::ECS::TaskDefinition", "True")] },
    exec: codeExec(), files: { [`/pipeline/${FLOORS_PATH}`]: CODE_FLOORS, [`${process.cwd()}/${FLOORS_PATH}`]: CODE_FLOORS }, ...over,
  });
  liveStack(state, stackFor(env, "gateway"), { parameters: { ImageDigest: DIGEST_B } });
  liveStack(state, stackFor(env, "web"), { outputs: { CloudUrl: "https://cloud.example.test/app", DeployedCloudSha: sha("4") } });
  liveStack(state, stackFor(env, "app"));
  seedLastGood(state, env);
  return state;
}

interface Run { state: FakeState; gates: Gate[]; inputs: Partial<Inputs> }
const ROLLBACK: Partial<Inputs> = { declaredRollback: true, codeCtxGiven: true, codeLiveSha: LIVE, codeTarget: OLD, cloudRef: "v0.13.10" };
const newRun = (state: FakeState, inputs: Partial<Inputs> = ROLLBACK, gates: Gate[] = [integrity, floorGate]): Run => ({ state, gates, inputs });
async function step(run: Run, env: PipelineEnv, name: StepName, inputs: Partial<Inputs> = {}): Promise<void> {
  const previous = run.state.files["out/manifest.json"];
  if (previous !== undefined) run.state.files["/in/manifest.json"] = previous;
  const ctx = makeCtx(run.state, env, name, {
    inputs: { manifestPath: previous === undefined ? null : "/in/manifest.json", ...run.inputs, ...inputs }, gates: run.gates,
    required: { preflight: ["rollback-floor"], "change-sets": ["change-set-integrity"], "gateway-live": [], proof: [] },
  });
  await runStep(ctx, STEPS[name]);
}
const manifestOf = (state: FakeState): Manifest => parseManifest(state.files["out/manifest.json"]!);
const refuses = async (promise: Promise<unknown>, exitName: string, text?: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  if (text !== undefined) await expect(promise).rejects.toThrow(text);
};

describe("PIPELINE_MODE=rollback with a Code target", () => {
  it("is a declared rollback even though CLOUD_REF is the live tag; Code keeps releasing, the pin is the target, the live commit is what Code moves from", async () => {
    const run = newRun(world());
    await step(run, "beta", "preflight");
    const m = manifestOf(run.state);
    expect(m).toMatchObject({
      mode: "rollback", cloud: { tag: "v0.13.10", sha: sha("4") },
      code: { release: "run", requestedRelease: "run", pinnedSha: { beta: OLD, production: null }, liveSha: { beta: LIVE, production: null }, rollbackTarget: OLD },
    });
    expect(m.stages.beta!.rollback).toMatchObject({ code: { liveSha: LIVE } });
    const exportsFile = run.state.files["out/exports.env"]!;
    expect(exportsFile).toContain("export CODE_RELEASE_EFFECTIVE='run'");
    expect(exportsFile).toContain(`export CODE_PINNED_SHA='${OLD}'`);
    expect(exportsFile).toContain("export CLOUD_MODE='rollback'");
    expect(run.state.files["out/summary.txt"]).toContain(`  NOTE   : Code rolls back to ${OLD.slice(0, 12)} (from ${LIVE.slice(0, 12)}); Cloud stays`);
    // the rollback-floor gate ran in preflight and judged the target
    expect(m.stages.beta!.gates.find((g) => g.name === "rollback-floor" && g.phase === "preflight")).toMatchObject({ result: "pass" });
  });

  it("a Cloud rollback plus a Code target: the older tag, the same target, Code still releases", async () => {
    const state = world();
    const run = newRun(state, { ...ROLLBACK, cloudRef: "v0.13.2" });
    await step(run, "beta", "preflight");
    expect(manifestOf(state)).toMatchObject({ mode: "rollback", cloud: { tag: "v0.13.2" }, code: { release: "run", rollbackTarget: OLD } });
    expect(state.files["out/summary.txt"]).toContain("Cloud rolls back");
  });

  it("without a target a declared rollback is Cloud-only: Code is skipped and pinned to what is live (from CODE_CTX); on the live tag it would change nothing and is refused", async () => {
    await refuses(step(newRun(world(), { ...ROLLBACK, codeTarget: null }), "beta", "preflight"), "ROLLBACK_REFUSED", /changes nothing/);
    const run = newRun(world(), { ...ROLLBACK, codeTarget: null, cloudRef: "v0.13.2" });
    await step(run, "beta", "preflight");
    expect(manifestOf(run.state)).toMatchObject({ mode: "rollback", code: { release: "skip", pinnedSha: { beta: LIVE }, rollbackTarget: null } });
    expect(run.state.files["out/exports.env"]).toContain("export CODE_RELEASE_EFFECTIVE='skip'");
    expect(run.state.files["out/summary.txt"]).toMatch(/rollback run: Code is skipped and pinned to d{12}/);
    // and an older tag without PIPELINE_MODE=rollback is still detected as a rollback with Code skipped (unchanged)
    const detected = newRun(world(), { codeCtxGiven: true, codeLiveSha: LIVE, cloudRef: "v0.13.2" });
    await step(detected, "beta", "preflight");
    expect(manifestOf(detected.state)).toMatchObject({ mode: "rollback", code: { release: "skip", pinnedSha: { beta: LIVE }, rollbackTarget: null } });
  });

  it("a forward run is unchanged: release mode, no target, no pin, Code releases; CODE_CTX live is still recorded", async () => {
    const run = newRun(world(), { codeCtxGiven: true, codeLiveSha: LIVE, cloudRef: "v0.13.10" });
    await step(run, "beta", "preflight");
    expect(manifestOf(run.state)).toMatchObject({ mode: "release", code: { release: "run", pinnedSha: { beta: null }, liveSha: { beta: LIVE }, rollbackTarget: null } });
    expect(run.state.files["out/exports.env"]).toContain("export CODE_RELEASE_EFFECTIVE='run'");
  });

  it("refuses: CODE_RELEASE=skip beside a target, a target without the declared mode, a target equal to the live Code, and a declared rollback that would move Cloud forward", async () => {
    await refuses(step(newRun(world()), "beta", "preflight", { codeRelease: "skip" }), "ROLLBACK_REFUSED", /needs CODE_RELEASE=run/);
    await refuses(step(newRun(world()), "beta", "preflight", { declaredRollback: false }), "USAGE", /needs PIPELINE_MODE=rollback/);
    await refuses(step(newRun(world()), "beta", "preflight", { codeTarget: LIVE }), "ROLLBACK_REFUSED", /nothing to roll back/);
    // live Cloud is v0.13.9 (sha 3): CLOUD_REF unset means the newest tag v0.13.10, which is newer than live
    const behind = world();
    behind.stacks[stackFor("beta", "web")]!.outputs.DeployedCloudSha = sha("3");
    await refuses(step(newRun(behind, { ...ROLLBACK, cloudRef: null }), "beta", "preflight"), "ROLLBACK_REFUSED", /never moves Cloud forward/);
    await refuses(step(newRun(behind, { ...ROLLBACK, cloudRef: "v0.13.10" }), "beta", "preflight"), "ROLLBACK_REFUSED", /never moves Cloud forward/);
    expect(behind.calls.some((c) => c.startsWith("cdk "))).toBe(false);
    // a rollback with no live Code commit cannot pin
    await refuses(step(newRun(world(), { ...ROLLBACK, codeLiveSha: null, codeTarget: null, cloudRef: "v0.13.2" }), "beta", "preflight"), "ROLLBACK_REFUSED", /live Code commit/);
  });

  it("an adoption run cannot be a rollback", async () => {
    const state = world();
    await refuses(decideMode(makePorts(state), { requested: "run", resolved: { tag: "v0.13.10", sha: sha("4"), ref: "CLOUD_REF", trunk: "cloud/next" }, liveSha: sha("4"), adopt: true, env: "beta", declared: true }), "REFUSED", /cannot also be a rollback/);
    expect(() => buildInputs({}, { EXEC_ID, AWS_REGION: "us-east-1", PIPELINE_MODE: "rollback", PIPELINE_ADOPT: "1" }, new Date())).toThrow(/contradicts/);
  });

  it("a pipeline execution without CODE_CTX is refused in the Preflight (nothing is guessed); a hand-started one passes its facts by variable", async () => {
    await refuses(step(newRun(world(), { ...ROLLBACK, codeCtxGiven: false }), "beta", "preflight"), "REFUSED", /CODE_CTX is not set/);
    const local = newRun(world(), { ...ROLLBACK, codeCtxGiven: false, execId: "local-hand-run" });
    await step(local, "beta", "preflight");
    expect(manifestOf(local.state)).toMatchObject({ mode: "rollback", code: { rollbackTarget: OLD, pinnedSha: { beta: OLD } } });
    await refuses(step(newRun(world(), { ...ROLLBACK, supersedes: { executionId: EXEC_ID, codeSha: null } }), "beta", "preflight"), "REFUSED", /cannot supersede itself/);
  });

  it("the last-good record and the drift check name the Code that will be live (the target), not the commit the run came from", async () => {
    const run = newRun(world(), { ...ROLLBACK, codeSha: sha("c") });
    await step(run, "beta", "preflight");
    const m = manifestOf(run.state);
    expect(m.code.sha).toBe(sha("c"));
    expect(codeShaThatWillBeLive(m, "beta")).toMatchObject({ sha: OLD });
    m.gateway.digest = DIGEST_A;
    expect(buildLastGood(m, "beta", [], null, new Date(0)).code.sha).toBe(OLD);
    // Cloud-only rollback: the pin of the Code that stays
    const only = newRun(world(), { ...ROLLBACK, codeTarget: null, cloudRef: "v0.13.2" });
    await step(only, "beta", "preflight");
    expect(codeShaThatWillBeLive(manifestOf(only.state), "beta")).toMatchObject({ sha: LIVE });
  });

  it("the drift gate checks Cloud against the target Code (the clone must hold it)", async () => {
    const run = newRun(world(), { ...ROLLBACK, codeSha: sha("c") });
    await step(run, "beta", "preflight");
    const m = manifestOf(run.state);
    const seen: string[] = [];
    const exec = codeExec();
    const state = world({ exec: (cmd, args) => { if (cmd === "npm") seen.push(args.join(" ")); return exec(cmd, args); } });
    const input: GateInput = { env: "beta", phase: "preflight", region: "us-east-1", config, manifest: m, changeSets: [], dirs: { pipeline: "/pipeline", cloud: "/cloud", out: "out", work: "/w" }, ports: makePorts(state), log: () => {} };
    state.files["/cloud/package.json"] = '{"scripts":{"contract:drift":"x"}}';
    await drift.run(input);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((line) => line.includes(`--code-ref ${OLD}`))).toBe(true);
  });
});

describe("the rollback-floor gate: the `code` group", () => {
  const gateInput = (state: FakeState, over: Partial<Manifest["code"]> = {}, mode: Manifest["mode"] = "rollback"): GateInput => ({
    env: "beta", phase: "preflight", region: "us-east-1", config, ports: makePorts(state), log: () => {}, changeSets: [], dirs: { pipeline: "/pipeline", cloud: "/c", out: "/o", work: "/w" },
    manifest: {
      schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode, cloud: { tag: "v0.13.10", sha: sha("4"), ref: "CLOUD_REF", trunk: "cloud/next", liveSha: { beta: sha("4"), production: null } },
      code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null, liveSha: { beta: LIVE, production: null }, rollbackTarget: OLD, ...over },
      gateway: { digest: null, source: null, imageTag: null, repository: null }, stages: {},
    },
  });

  it("passes a target equal to or above every code floor, and names the floor's reason for one below", async () => {
    for (const target of [OLD, MID]) expect((await floorGate.run(gateInput(world(), { rollbackTarget: target }))).result).toBe("pass");
    const below = await floorGate.run(gateInput(world(), { rollbackTarget: FLOOR }));
    expect(below.result).toBe("fail");
    expect(below.failures).toEqual([`the Code target ${FLOOR.slice(0, 12)} is below the code floor ${OLD.slice(0, 12)}: Code before the second train sends a payload Cloud no longer reads`]);
  });

  it("fails closed: no Code clone, a target or floor the clone does not hold, an unusable floor, a git error", async () => {
    expect((await floorGate.run(gateInput(world({ exec: codeExec(false) })))).failures?.[0]).toMatch(/no Code clone was provided \(ROVARA_CODE_REPO\)/);
    expect((await floorGate.run(gateInput(world({ exec: codeExec(true, [OLD, LIVE]) }), { rollbackTarget: MID }))).failures?.[0]).toMatch(/is not in the Code clone/);
    expect((await floorGate.run(gateInput(world({ exec: codeExec(true, [MID, LIVE]) }), { rollbackTarget: MID }))).failures?.[0]).toMatch(/code floor .* is not in the Code clone/);
    const unusable = world({ files: { [`/pipeline/${FLOORS_PATH}`]: JSON.stringify({ schema: 1, floors: { code: ["abc1234"] } }) } });
    expect((await floorGate.run(gateInput(unusable))).failures?.[0]).toMatch(/not a full 40-hex sha/);
    const broken = world({ exec: (cmd, args) => (args.includes("merge-base") ? { code: 128, stdout: "", stderr: "" } : codeExec()(cmd, args)) });
    expect((await floorGate.run(gateInput(broken))).failures?.[0]).toMatch(/could not compare/);
  });

  it("is not judged when no code floor exists (a note), when the run has no target, or in a release run; code floors never judge the Cloud ref", async () => {
    const none = world({ files: { [`/pipeline/${FLOORS_PATH}`]: JSON.stringify({ schema: 1, floors: { web: [sha("1")] } }) }, exec: codeExec(false) });
    expect(await floorGate.run(gateInput(none))).toMatchObject({ result: "pass", notes: [expect.stringMatching(/no code floors/u)] });
    expect((await floorGate.run(gateInput(world({ exec: codeExec(false) }), { rollbackTarget: null }))).result).toBe("pass");
    expect((await floorGate.run(gateInput(world({ exec: codeExec(false) }), { rollbackTarget: FLOOR }, "release"))).result).toBe("pass");
    // the Cloud ref (sha 4) is not an ancestor of the code floor in git terms, and the group `code` is not judged against it
    expect(parseFloors(CODE_FLOORS).floors.map((f) => f.group)).toEqual(["code", "web"]);
    expect((await floorGate.run(gateInput(world(), { rollbackTarget: null }))).data).toMatchObject({ floors: 1 });
  });

  it("stops a rollback run in the Preflight (exit 20) before any change set when the target is below a floor", async () => {
    const run = newRun(world(), { ...ROLLBACK, codeTarget: FLOOR });
    await refuses(step(run, "beta", "preflight"), "GATE_FAILED", /rollback-floor/);
    expect(run.state.calls.some((c) => c.startsWith("cdk "))).toBe(false);
    expect(JSON.parse(run.state.files["out/gates/preflight-rollback-floor.json"]!)).toMatchObject({ result: "fail", failures: [expect.stringMatching(/below the code floor/u)] });
  });

  it("the committed floors file keeps a `code` group (empty until the controller names a Code floor) and the Cloud floors unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const floors = parseFloors(readFileSync(new URL("../../ops/pipeline/rollback-floors.json", import.meta.url), "utf8"));
    expect(floors.floors.filter((f) => f.group === "code")).toEqual([]);
    expect((JSON.parse(readFileSync(new URL("../../ops/pipeline/rollback-floors.json", import.meta.url), "utf8")) as { floors: object }).floors).toHaveProperty("code");
    expect(floors.floors.map((f) => f.group).sort()).toEqual(["gateway", "gateway", "web", "web"]);
  });
});

describe("production joins a Code rollback decided in beta", () => {
  const prodWorld = (): FakeState => {
    const prod = world({}, "production");
    prod.stacks[stackFor("production", "web")]!.outputs.DeployedCloudSha = sha("4");
    return prod;
  };
  /** A real beta execution that ran its proof (the manifest production is handed). */
  async function betaDone(inputs: Partial<Inputs>): Promise<Record<string, string>> {
    const run = newRun(world(), inputs);
    await step(run, "beta", "preflight");
    const m = JSON.parse(run.state.files["out/manifest.json"]!) as { stages: { beta: { completed: string[] } } };
    m.stages.beta.completed = ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"];
    run.state.files["out/manifest.json"] = JSON.stringify(m);
    return run.state.files;
  }
  const PROD_LIVE = sha("e");

  it("pins production to the same target, records production's own live commit, and keeps beta's supersession (production's CODE_CTX says none)", async () => {
    const files = await betaDone({ ...ROLLBACK, supersedes: { executionId: WAITING, codeSha: MID } });
    const prod = prodWorld();
    prod.files = { ...files };
    const run = newRun(prod, { ...ROLLBACK, cloudProd: true, codeLiveSha: PROD_LIVE, supersedes: null });
    await step(run, "production", "preflight");
    const m = manifestOf(prod);
    expect(m.code).toMatchObject({ pinnedSha: { beta: OLD, production: OLD }, liveSha: { beta: LIVE, production: PROD_LIVE }, rollbackTarget: OLD, supersedes: { executionId: WAITING, codeSha: MID } });
    expect(m.stages.production!.rollback).toMatchObject({ code: { liveSha: PROD_LIVE } });
    expect(prod.files["out/summary.txt"]).toContain(`NOTE   : this run supersedes execution ${WAITING.slice(0, 8)}, whose Code sha ${MID.slice(0, 12)} is not promoted`);
    expect(prod.files["out/summary.txt"]).toContain(`Code rolls back to ${OLD.slice(0, 12)} (from ${PROD_LIVE.slice(0, 12)})`);
  });

  it("refuses a production CODE_CTX that names another target or another supersession, and a rollback without production's live commit", async () => {
    const files = await betaDone({ ...ROLLBACK, supersedes: { executionId: WAITING, codeSha: MID } });
    const attempt = (inputs: Partial<Inputs>): Promise<void> => {
      const prod = prodWorld();
      prod.files = { ...files };
      return step(newRun(prod, { ...ROLLBACK, cloudProd: true, supersedes: null, ...inputs }), "production", "preflight");
    };
    await refuses(attempt({ codeTarget: MID }), "REFUSED", /a run has one Code target/);
    await refuses(attempt({ codeTarget: null }), "REFUSED", /a run has one Code target/);
    await refuses(attempt({ supersedes: { executionId: "11111111-1111-4111-8111-111111111111", codeSha: null } }), "REFUSED", /decided once, by beta/);
    await refuses(attempt({ codeLiveSha: null }), "ROLLBACK_REFUSED", /live Code commit/);
    await step(newRun((() => { const p = prodWorld(); p.files = { ...files }; return p; })(), { ...ROLLBACK, cloudProd: true, supersedes: { executionId: WAITING, codeSha: MID } }), "production", "preflight");
  });

  it("a hand-started production run without CODE_CTX still takes the target from the manifest", async () => {
    const files = await betaDone({ ...ROLLBACK, codeCtxGiven: false, execId: "local-hand-run" });
    const prod = prodWorld();
    prod.files = { ...files };
    await step(newRun(prod, { ...ROLLBACK, cloudProd: true, codeCtxGiven: false, codeTarget: null, execId: "local-hand-run" }), "production", "preflight");
    expect(manifestOf(prod).code.pinnedSha).toMatchObject({ beta: OLD, production: OLD });
  });
});

describe("REVIEW (Opus): a declared rollback must not move production's Cloud forward", () => {
  it("production lagging beta: a Code-only rollback naming beta's live tag would move production's Cloud forward", async () => {
    const run = newRun(world());
    await step(run, "beta", "preflight");
    const m = JSON.parse(run.state.files["out/manifest.json"]!) as { stages: { beta: { completed: string[] } } };
    m.stages.beta.completed = ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"];
    run.state.files["out/manifest.json"] = JSON.stringify(m);
    const prod = world({}, "production");
    prod.stacks[stackFor("production", "web")]!.outputs.DeployedCloudSha = sha("2"); // production still runs v0.13.2
    prod.files = { ...run.state.files };
    const attempt = step(newRun(prod, { ...ROLLBACK, cloudProd: true, codeLiveSha: sha("e") }), "production", "preflight");
    await expect(attempt).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED" });
  });

  const betaProofDone = async (inputs: Partial<Inputs> = ROLLBACK): Promise<Record<string, string>> => {
    const run = newRun(world(), inputs);
    await step(run, "beta", "preflight");
    const m = JSON.parse(run.state.files["out/manifest.json"]!) as { stages: { beta: { completed: string[] } } };
    m.stages.beta.completed = ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"];
    run.state.files["out/manifest.json"] = JSON.stringify(m);
    return run.state.files;
  };
  const prodAt = (liveSha: string | null, files: Record<string, string>): FakeState => {
    const prod = world({}, "production");
    if (liveSha === null) delete prod.stacks[stackFor("production", "web")]!.outputs.DeployedCloudSha;
    else prod.stacks[stackFor("production", "web")]!.outputs.DeployedCloudSha = liveSha;
    prod.files = { ...files };
    return prod;
  };

  it("production: the live Cloud or a newer one is refused only when the manifest's Cloud is not older; an older manifest Cloud (a real rollback) passes and the summary says it rolls back", async () => {
    const files = await betaProofDone({ ...ROLLBACK, cloudRef: "v0.13.2" }); // beta rolled back to v0.13.2
    // production runs v0.13.10 (sha 4): v0.13.2 is older, so a rollback
    const ok = prodAt(sha("4"), files);
    await step(newRun(ok, { ...ROLLBACK, cloudRef: "v0.13.2", cloudProd: true, codeLiveSha: sha("e") }), "production", "preflight");
    expect(ok.files["out/summary.txt"]).toContain("Cloud rolls back");
    // production already on v0.13.2: stays
    const same = prodAt(sha("2"), files);
    await step(newRun(same, { ...ROLLBACK, cloudRef: "v0.13.2", cloudProd: true, codeLiveSha: sha("e") }), "production", "preflight");
    expect(same.files["out/summary.txt"]).toContain("Cloud stays");
    // production on a commit unknown to git: not provable, refused
    await expect(step(newRun(prodAt(sha("f"), files), { ...ROLLBACK, cloudRef: "v0.13.2", cloudProd: true, codeLiveSha: sha("e") }), "production", "preflight")).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED" });
    // production live below the manifest's Cloud (production lags beta): forward, refused, nothing created
    const lag = prodAt(sha("1"), files);
    await expect(step(newRun(lag, { ...ROLLBACK, cloudRef: "v0.13.2", cloudProd: true, codeLiveSha: sha("e") }), "production", "preflight")).rejects.toThrow(/never moves Cloud forward/);
    expect(lag.calls.some((c) => c.startsWith("cdk "))).toBe(false);
  });

  it("production with an unknown live Cloud: a warning, and the summary says the Cloud change is not proven (never 'stays' or 'rolls back')", async () => {
    const files = await betaProofDone();
    const prod = prodAt(null, files);
    await step(newRun(prod, { ...ROLLBACK, cloudProd: true, codeLiveSha: sha("e") }), "production", "preflight");
    const text = prod.files["out/summary.txt"]!;
    expect(text).toContain("the live Cloud is unknown, so whether it stays or rolls back is not proven");
    expect(text).toMatch(/WARN +: production's live Cloud sha is unknown/);
    expect(text).not.toMatch(/Cloud stays|Cloud rolls back/);
  });

  it("a detected (not declared) rollback in production is held to the same rule", async () => {
    const files = await betaProofDone({ codeCtxGiven: true, codeLiveSha: LIVE, cloudRef: "v0.13.2" });
    const lag = prodAt(sha("1"), files);
    await expect(step(newRun(lag, { codeCtxGiven: true, codeLiveSha: sha("e"), cloudRef: "v0.13.2", cloudProd: true }), "production", "preflight")).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED" });
  });

  it("a hand-started production run naming a CODE_ROLLBACK_TARGET other than the manifest's is refused, not ignored", async () => {
    const files = await betaProofDone({ ...ROLLBACK, codeCtxGiven: false, execId: "local-hand-run", cloudRef: "v0.13.2" });
    const attempt = (target: string | null) => step(newRun(prodAt(sha("4"), files), { ...ROLLBACK, cloudRef: "v0.13.2", cloudProd: true, codeCtxGiven: false, codeTarget: target, execId: "local-hand-run" }), "production", "preflight");
    await expect(attempt(MID)).rejects.toThrow(/a run has one Code target/);
    await attempt(OLD);
    await attempt(null);
  });

  it("the log says 'this run promotes' only when the run releases Code; the drift gate's remedy never advises CODE_RELEASE=skip beside a target", async () => {
    const logs: string[] = [];
    const ctx = makeCtx(world(), "beta", "preflight", { inputs: { codeCtxGiven: true, codeLiveSha: LIVE, codeRelease: "skip", codeSha: MID, cloudRef: "v0.13.2", supersedes: { executionId: WAITING, codeSha: MID } }, gates: [integrity], required: { preflight: [], "change-sets": [], "gateway-live": [], proof: [] }, logs });
    await runStep(ctx, preflight);
    expect(logs.join("\n")).toContain("is not promoted");
    expect(logs.join("\n")).not.toContain("this run promotes");
    // the remedy text of the drift gate in a Code rollback
    const run = newRun(world(), { ...ROLLBACK, codeSha: sha("c"), cloudRef: "v0.13.2" });
    await step(run, "beta", "preflight");
    const m = manifestOf(run.state);
    const state = world({ exec: (cmd, args) => (cmd === "npm" ? { code: 1, stdout: "", stderr: "DRIFT x" } : codeExec()(cmd, args)) });
    state.files["/cloud/package.json"] = '{"scripts":{"contract:drift":"x"}}';
    const out = await drift.run({ env: "beta", phase: "preflight", region: "us-east-1", config, manifest: m, changeSets: [], dirs: { pipeline: "/pipeline", cloud: "/cloud", out: "out", work: "/w" }, ports: makePorts(state), log: () => {} });
    expect(out.result).toBe("fail");
    expect(out.failures!.join(" ")).toContain("this is a Code rollback");
    expect(out.failures!.join(" ")).not.toContain("CODE_RELEASE=skip");
  });
});

describe("supersession (R5): printed from CODE_CTX, never invented", () => {
  const summaryFor = (code: Partial<Manifest["code"]>, mode: Manifest["mode"] = "release"): string => {
    const m = parseManifest(JSON.stringify({
      schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode, cloud: { tag: "v1.0.0", sha: sha("a"), trunk: "t" }, gateway: { digest: DIGEST_A, source: "built" }, code: { sha: sha("c"), ...code },
      stages: { beta: { startedAt: "t" } },
    }));
    return renderSummary(buildSummary(m, "beta", m.stages.beta!));
  };

  it("names a commit as promoted only when this run releases that very commit; a rollback never promotes it; none prints no note", () => {
    const waiting = { executionId: WAITING, codeSha: sha("c") };
    expect(summaryFor({ supersedes: waiting })).toContain(`whose Code sha ${"c".repeat(12)} is promoted by this run`);
    expect(summaryFor({ supersedes: { executionId: WAITING, codeSha: sha("e") } })).toContain(`whose Code sha ${"e".repeat(12)} is not promoted`);
    expect(summaryFor({ supersedes: waiting, release: "skip" })).toContain("is not promoted");
    expect(summaryFor({ supersedes: waiting, rollbackTarget: OLD, pinnedSha: { beta: OLD, production: null } }, "rollback")).toContain("is not promoted");
    expect(summaryFor({ supersedes: { executionId: WAITING, codeSha: null } })).toContain("whose Code sha none is not promoted");
    expect(summaryFor({})).not.toContain("supersedes");
  });

  it("the preflight logs it from the manifest and reads a manifest from before L9b (no liveSha, no target) tolerantly", async () => {
    const logs: string[] = [];
    const state = world();
    const ctx = makeCtx(state, "beta", "preflight", { inputs: { ...ROLLBACK, supersedes: { executionId: WAITING, codeSha: MID } }, gates: [integrity, floorGate], required: { preflight: [], "change-sets": [], "gateway-live": [], proof: [] }, logs });
    await runStep(ctx, preflight);
    expect(logs.join("\n")).toContain(`this run supersedes execution ${WAITING.slice(0, 8)}, whose Code sha ${MID.slice(0, 12)} is not promoted`);
    expect(logs.join("\n")).toContain(`Code rolls back to ${OLD.slice(0, 12)} (from ${LIVE.slice(0, 12)})`);
    const old = parseManifest(JSON.stringify({ schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "t", mode: "release", cloud: { tag: "v1.0.0", sha: sha("a"), trunk: "t" }, code: { sha: sha("c") } }));
    expect(old.code).toMatchObject({ liveSha: { beta: null, production: null }, rollbackTarget: null });
    expect(renderExports(old, "beta")).toContain("export CODE_RELEASE_EFFECTIVE='run'");
  });
});

describe("rollback-plan --code-target", () => {
  const LAST_GOOD = "/rovara-cloud/beta/release/last-good";
  const record = JSON.stringify({
    schema: 1, env: "beta", recordedAt: "2026-11-24T10:00:00.000Z", executionId: "aaaabbbb-0000-4000-8000-000000000000", mode: "release",
    cloud: { tag: "v0.13.10", sha: sha("4") }, gateway: { digest: DIGEST_A }, code: { sha: LIVE }, proofGates: [],
    previous: { cloudTag: "v0.13.9", cloudSha: sha("3"), gatewayDigest: DIGEST_B },
  });
  const planWorld = (over: Partial<FakeState> = {}): FakeState => { const s = world(over); s.ssm[LAST_GOOD] = record; return s; };
  const plan = (state: FakeState, codeTarget: string | null, which: "last-good" | "previous" = "last-good"): Promise<string[]> =>
    planRollback({ ports: makePorts(state), config, env: "beta", which, codeLiveSha: null, pipelineDir: "/pipeline", codeTarget });

  it("prints the full variable set for a Code-only rollback (the live tag stays) and says where the history is", async () => {
    expect(await plan(planWorld(), OLD)).toEqual([
      "ROLLBACK PLAN beta with a Code rollback  (read-only: nothing was changed)",
      `  Live   : v0.13.10 ${sha("4").slice(0, 12)}`,
      `  Cloud  : stays at v0.13.10  (last-good, recorded 2026-11-24T10:00:00.000Z by execution aaaabbbb, mode release)`,
      `  Code   : rolls back to ${OLD.slice(0, 12)}`,
      `  Gateway: ${DIGEST_A}`,
      "  Floors : 1 cloud floor(s) checked, none below",
      "  Run the pipeline with these variables (CODE_LIVE_SHA and the supersession are supplied by the pipeline itself):",
      "    PIPELINE_MODE=rollback",
      `    CODE_ROLLBACK_TARGET=${OLD}`,
      "    CODE_RELEASE=run",
      "    CLOUD_REF=v0.13.10",
      `    GATEWAY_DIGEST=${DIGEST_A}`,
      "  NOTE   : the target must be in the beta Code release history; read it in the release account: aws ssm get-parameter --name /agentx/release/code-history/beta",
      "  NOTE   : Production's own Preflight checks Production's history: roll Production back only to a Code commit Production released. Production still waits for the owner's approval",
    ]);
  });

  it("plans a Cloud rollback together with the Code target, and refuses a Code target below a code floor when a clone is available", async () => {
    const both = await plan(planWorld(), MID, "previous");
    expect(both).toContain("    CLOUD_REF=v0.13.9");
    expect(both).toContain("    CODE_RELEASE=run");
    expect(both.find((l) => l.startsWith("  Cloud  :"))).toContain("v0.13.9");
    await expect(plan(planWorld(), FLOOR)).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED", message: expect.stringMatching(/below the code floor/u) as string });
  });

  it("without a Code clone it says the Code floors are left to the pipeline's gate; a plan without a target is unchanged and a Cloud-only plan still refuses 'already live'", async () => {
    const noClone = await plan(planWorld({ exec: codeExec(false) }), FLOOR);
    expect(noClone.some((l) => /WARN +: the Code target was not judged .* the pipeline's rollback-floor gate judges it/u.test(l))).toBe(true);
    await expect(plan(planWorld(), null)).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED", message: expect.stringMatching(/already what beta runs/u) as string });
    const plain = await plan(planWorld(), null, "previous");
    expect(plain).toContain("    CODE_RELEASE=skip");
  });

  it("the command takes --code-target, prints the plan and refuses a target that is not a full sha", async () => {
    const lines: string[] = [];
    const state = planWorld();
    const env = { EXEC_ID: "local-plan", AWS_REGION: "us-east-1", ROVARA_EXPECTED_DEPLOY_ACCOUNT: FAKE_ACCOUNT };
    const deps = { config, switchesFile: fakeSwitches, gates: [], requiredGates: {}, makePorts: () => makePorts(state), out: (l: string) => { lines.push(l); } };
    expect(await main(["beta", "rollback-plan", "--code-target", OLD], env, deps)).toBe(0);
    expect(lines.join("\n")).toContain(`CODE_ROLLBACK_TARGET=${OLD}`);
    lines.length = 0;
    expect(await main(["beta", "rollback-plan", "--code-target", "abc"], env, deps)).toBe(2);
  });
});

describe("decideMode", () => {
  const resolved = (tag: string, s: string) => ({ tag, sha: s, ref: "CLOUD_REF" as const, trunk: "cloud/next" });
  const decide = (args: { ref: string; refSha: string; live: string | null; declared?: boolean; target?: string | null; requested?: "run" | "skip" }) =>
    decideMode(makePorts(newState()), { requested: args.requested ?? "run", resolved: resolved(args.ref, args.refSha), liveSha: args.live, adopt: false, env: "beta", declared: args.declared ?? false, codeTarget: args.target ?? null });

  it("a declared rollback: live tag or older = rollback; newer or unknown-to-git = refused; unknown live = rollback with a warning", async () => {
    expect(await decide({ ref: "v0.13.2", refSha: sha("2"), live: sha("4"), declared: true })).toMatchObject({ mode: "rollback", codeRelease: "skip" });
    expect(await decide({ ref: "v0.13.10", refSha: sha("4"), live: sha("4"), declared: true, target: OLD })).toMatchObject({ mode: "rollback", codeRelease: "run" });
    await refuses(decide({ ref: "v0.13.10", refSha: sha("4"), live: sha("4"), declared: true }), "ROLLBACK_REFUSED", /changes nothing/);
    expect(await decide({ ref: "v0.13.2", refSha: sha("2"), live: sha("4"), declared: true, target: OLD })).toMatchObject({ mode: "rollback", codeRelease: "run" });
    expect((await decide({ ref: "v0.13.10", refSha: sha("4"), live: null, declared: true })).warnings.join(" ")).toMatch(/cannot be proven/);
    await refuses(decide({ ref: "v0.13.10", refSha: sha("4"), live: sha("3"), declared: true }), "ROLLBACK_REFUSED", /never moves Cloud forward/);
    await refuses(decide({ ref: "v0.13.10", refSha: sha("4"), live: sha("f"), declared: true }), "ROLLBACK_REFUSED", /never moves Cloud forward/);
  });

  it("not declared: as before (older = rollback with skip; the live tag = release honouring the request)", async () => {
    expect(await decide({ ref: "v0.13.2", refSha: sha("2"), live: sha("4") })).toMatchObject({ mode: "rollback", codeRelease: "skip" });
    expect(await decide({ ref: "v0.13.10", refSha: sha("4"), live: sha("4"), requested: "skip" })).toMatchObject({ mode: "release", codeRelease: "skip" });
  });
});
