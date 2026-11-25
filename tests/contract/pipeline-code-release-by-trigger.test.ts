// PIPELINE-CODE-RELEASE-BY-TRIGGER (Cloud half): CODE_RELEASE defaults to `from-trigger` in the public pipeline, and Beta's Preflight turns it into run or skip from WHICH SOURCE started
// the run (the trigger part of CODE_CTX, read by Code's Preflight from the execution's own record):
//   a Cloud release tag push -> skip; a Code mainline push -> run; an explicit run or skip on a run started by hand -> that value; anything else -> refused before any write.
// The drift gates are not touched: a run that carries Code (run) is judged exactly as before, and a skip run never reaches them with Code.
import { describe, expect, it } from "vitest";
import { gate as integrity } from "../../ops/pipeline/gates/change-set-integrity.gate.ts";
import { parseCodeCtx } from "../../ops/pipeline/lib/codectx.ts";
import { decideCodeRelease } from "../../ops/pipeline/lib/coderelease.ts";
import type { Inputs } from "../../ops/pipeline/lib/context.ts";
import { parseManifest } from "../../ops/pipeline/lib/manifest.ts";
import { runStep } from "../../ops/pipeline/lib/run.ts";
import { buildInputs, main } from "../../ops/pipeline/stage.ts";
import { preflight } from "../../ops/pipeline/steps/preflight.ts";
import { CDK_METADATA, DIGEST_B, EXEC_ID, FAKE_ACCOUNT, MODIFY_FUNCTION, config, fakeSwitches, liveStack, makeCtx, makePorts, newState, row, seedLastGood, sha, stackFor } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

const LIVE = sha("d");
const ctxBase = `live:${LIVE},target:none,supersedes:none,supersedesSha:none`;
const FROM = "from-trigger";

function betaWorld(): FakeState {
  const state = newState({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION], RovaraModelGateway: [row("Modify", "TaskDef", "AWS::ECS::TaskDefinition", "True")] } });
  liveStack(state, stackFor("beta", "gateway"), { parameters: { ImageDigest: DIGEST_B } });
  liveStack(state, stackFor("beta", "web"), { outputs: { CloudUrl: "https://cloud.example.test/app" } });
  liveStack(state, stackFor("beta", "app"));
  seedLastGood(state, "beta");
  return state;
}
const writes = (state: FakeState): string[] => state.calls.filter((call) => /^(cfn|cdk|ssm put|aws|git worktree)/u.test(call));

/** Beta's Preflight with a given CODE_RELEASE and trigger fact (a pipeline run: the Code facts arrive, as CODE_CTX does, with the trigger part). */
async function betaPreflight(inputs: Partial<Inputs>, state: FakeState = betaWorld()): Promise<{ state: FakeState; logs: string[]; manifest: () => ReturnType<typeof parseManifest> }> {
  const logs: string[] = [];
  const ctx = makeCtx(state, "beta", "preflight", {
    inputs: { codeCtxGiven: true, codeLiveSha: LIVE, execId: EXEC_ID, ...inputs }, gates: [integrity],
    required: { preflight: [], "change-sets": ["change-set-integrity"], "gateway-live": [], proof: [] }, logs,
  });
  await runStep(ctx, preflight);
  return { state, logs, manifest: () => parseManifest(state.files["out/manifest.json"]!) };
}
const TAG_RUN = { cloudRef: FROM, cloudSourceCommit: sha("3"), codeRelease: FROM } as const; // the commit v0.13.9 points at
const PUSH_RUN = { cloudRef: FROM, cloudSourceCommit: sha("5"), codeRelease: FROM } as const; // a trunk commit with no release tag (beta's last-good, v0.13.1, is kept)
const withTrigger = (trigger: Inputs["codeTrigger"]): Partial<Inputs> => ({ codeTrigger: trigger });

describe("CODE_CTX: the trigger part", () => {
  it("is optional (Production's value has none) and read as a kind", () => {
    expect(parseCodeCtx(ctxBase)).toEqual({ live: LIVE, target: null, supersedes: null, trigger: null });
    expect(parseCodeCtx(`${ctxBase},trigger:code-push`).trigger).toEqual({ kind: "code-push" });
    expect(parseCodeCtx(`${ctxBase},trigger:manual`).trigger).toEqual({ kind: "manual" });
    expect(parseCodeCtx(`${ctxBase},trigger:unknown`).trigger).toEqual({ kind: "unknown" });
    expect(parseCodeCtx(`${ctxBase},trigger:cloud-tag@v0.13.9`).trigger).toEqual({ kind: "cloud-tag", tag: "v0.13.9" });
  });
  it("refuses any other shape of it, never guessing", () => {
    for (const bad of ["trigger:", "trigger:Code-Push", "trigger:cloud-tag", "trigger:cloud-tag@", "trigger:cloud-tag@0.13.9", "trigger:cloud-tag@v0.13", "trigger:cloud-tag@v0.13.9-rc1", "trigger:cloud-tag@v1.2.3x", "trigger: code-push", "trig:code-push", "trigger:run", "trigger:code-push,more:1"]) {
      expect(() => parseCodeCtx(`${ctxBase},${bad}`), bad).toThrow(expect.objectContaining({ exitName: "REFUSED", message: expect.stringMatching(/^CODE_CTX is malformed/u) as string }) as Error);
    }
  });
  it("buildInputs carries it, and accepts from-trigger as CODE_RELEASE; a hand run has no trigger", () => {
    const base = { EXEC_ID, AWS_REGION: "us-east-1" };
    expect(buildInputs({}, { ...base, CODE_RELEASE: FROM, CODE_CTX: `${ctxBase},trigger:cloud-tag@v0.13.9` }, new Date())).toMatchObject({ codeRelease: FROM, codeTrigger: { kind: "cloud-tag", tag: "v0.13.9" } });
    expect(buildInputs({}, { ...base, CODE_RELEASE: FROM, CODE_CTX: ctxBase }, new Date())).toMatchObject({ codeRelease: FROM, codeTrigger: null });
    expect(buildInputs({}, { ...base, CODE_RELEASE: "skip" }, new Date())).toMatchObject({ codeRelease: "skip", codeTrigger: null });
    expect(() => buildInputs({}, { ...base, CODE_RELEASE: "latest" }, new Date())).toThrow(/CODE_RELEASE must be run, skip or from-trigger/u);
    expect(() => buildInputs({}, { ...base, CODE_RELEASE: "" , CODE_CTX: `${ctxBase},trigger:nope` }, new Date())).toThrow(/CODE_CTX is malformed/u);
  });
});

describe("decideCodeRelease", () => {
  const resolved = { tag: "v0.13.9", ref: "from-trigger" } as const;
  const decide = (codeRelease: Inputs["codeRelease"], codeTrigger: Inputs["codeTrigger"], ref: { tag: string; ref: "from-trigger" | "CLOUD_REF" | "last-good" | "latest-tag" } = resolved) => decideCodeRelease({ codeRelease, codeTrigger }, ref);

  it("a Cloud tag push skips Code, a Code push runs it", () => {
    expect(decide(FROM, { kind: "cloud-tag", tag: "v0.13.9" }).request).toBe("skip");
    expect(decide(FROM, { kind: "code-push" }).request).toBe("run");
    expect(decide(FROM, { kind: "code-push" }, { tag: "v0.13.1", ref: "last-good" }).request).toBe("run");
  });
  it("an explicit value wins, whatever the trigger says (a trigger cannot carry one; only a run started by hand can)", () => {
    for (const trigger of [null, { kind: "manual" }, { kind: "unknown" }, { kind: "code-push" }, { kind: "cloud-tag", tag: "v0.13.9" }] as const) {
      expect(decide("run", trigger).request, JSON.stringify(trigger)).toBe("run");
      expect(decide("skip", trigger).request, JSON.stringify(trigger)).toBe("skip");
    }
  });
  it("refuses every case it cannot decide: a hand run that left the default, an unproven trigger, no trigger fact, a pushed tag that is not the resolved one", () => {
    expect(() => decide(FROM, { kind: "manual" })).toThrow(/started by hand and left CODE_RELEASE at from-trigger/u);
    expect(() => decide(FROM, { kind: "unknown" })).toThrow(/could not be established/u);
    expect(() => decide(FROM, null)).toThrow(/none was given/u);
    expect(() => decide(FROM, { kind: "cloud-tag", tag: "v0.13.10" })).toThrow(/must be the same/u);
    expect(() => decide(FROM, { kind: "cloud-tag", tag: "v0.13.9" }, { tag: "v0.13.9", ref: "CLOUD_REF" })).toThrow(/must be the same/u);
    expect(() => decide(FROM, { kind: "cloud-tag", tag: "v0.13.9" }, { tag: "v0.13.1", ref: "last-good" })).toThrow(/must be the same/u);
    for (const attempt of [() => decide(FROM, { kind: "manual" }), () => decide(FROM, null)]) expect(attempt).toThrow(expect.objectContaining({ exitName: "REFUSED" }) as Error);
  });
});

describe("Beta's Preflight, by trigger", () => {
  it("a Cloud tag push: Cloud v0.13.9 is released, Code is skipped (the manifest and the exports say skip)", async () => {
    const run = await betaPreflight({ ...TAG_RUN, ...withTrigger({ kind: "cloud-tag", tag: "v0.13.9" }) });
    expect(run.manifest()).toMatchObject({ cloud: { tag: "v0.13.9", ref: "from-trigger" }, code: { release: "skip", requestedRelease: "skip" } });
    expect(run.state.files["out/exports.env"]).toContain("export CODE_RELEASE_EFFECTIVE='skip'");
    expect(run.logs.join("\n")).toMatch(/Code release requested: skip \(the Cloud release tag v0\.13\.9 started this run/u);
    expect(run.manifest().stages.beta!.warnings.join("\n")).toContain("Code is not released by this run");
  });

  it("a Code push: Code is released (run), on the Cloud that beta has recorded as good", async () => {
    const state = betaWorld();
    state.history.push(sha("5"));
    const run = await betaPreflight({ ...PUSH_RUN, ...withTrigger({ kind: "code-push" }) }, state);
    expect(run.manifest()).toMatchObject({ cloud: { tag: "v0.13.1", ref: "last-good" }, code: { release: "run", requestedRelease: "run" } });
    expect(run.state.files["out/exports.env"]).toContain("export CODE_RELEASE_EFFECTIVE='run'");
    expect(run.manifest().stages.beta!.warnings.join("\n")).not.toContain("Code is not released by this run");
  });

  it("a Code push while the Cloud commit still carries the newest tag is still a Code push: run (the tag on the commit does not decide it)", async () => {
    const run = await betaPreflight({ ...TAG_RUN, ...withTrigger({ kind: "code-push" }) });
    expect(run.manifest()).toMatchObject({ cloud: { tag: "v0.13.9" }, code: { release: "run" } });
  });

  it("an explicit value on a run started by hand wins: run, and skip", async () => {
    for (const value of ["run", "skip"] as const) {
      const run = await betaPreflight({ cloudRef: "v0.13.9", codeRelease: value, ...withTrigger({ kind: "manual" }) });
      expect(run.manifest().code, value).toMatchObject({ release: value, requestedRelease: value });
    }
  });

  it("refuses, before any write, a run it cannot decide: a hand run that left the default, an unproven trigger, no trigger fact, a tag that is not the resolved one", async () => {
    const cases: Array<[Partial<Inputs>, RegExp]> = [
      [{ ...TAG_RUN, ...withTrigger({ kind: "manual" }) }, /started by hand/u],
      [{ cloudRef: "v0.13.9", codeRelease: FROM, ...withTrigger({ kind: "manual" }) }, /started by hand/u],
      [{ ...TAG_RUN, ...withTrigger({ kind: "unknown" }) }, /could not be established/u],
      [{ ...TAG_RUN, ...withTrigger(null) }, /none was given/u],
      [{ ...TAG_RUN, ...withTrigger({ kind: "cloud-tag", tag: "v0.13.2" }) }, /must be the same/u],
    ];
    for (const [inputs, text] of cases) {
      const state = betaWorld();
      await expect(betaPreflight(inputs, state)).rejects.toMatchObject({ exitName: "REFUSED", message: expect.stringMatching(text) as string });
      expect(writes(state), JSON.stringify(inputs)).toEqual([]);
      expect(state.files["out/manifest.json"]).toBeUndefined();
    }
  });

  it("a skip run is still a rollback-safe skip: a declared rollback with a Code target and a from-trigger default is refused (a rollback is started by hand)", async () => {
    const target = sha("2");
    await expect(betaPreflight({ cloudRef: "v0.13.9", codeRelease: FROM, declaredRollback: true, codeTarget: target, ...withTrigger({ kind: "manual" }) })).rejects.toMatchObject({ exitName: "REFUSED" });
  });
});

describe("the read-only `ref` step decides CODE_RELEASE the same way (it is how a person plans a run by hand)", () => {
  const env = { EXEC_ID, AWS_REGION: "us-east-1", ROVARA_EXPECTED_DEPLOY_ACCOUNT: FAKE_ACCOUNT, CLOUD_REF: FROM, CLOUD_SOURCE_COMMIT: sha("3"), CODE_RELEASE: FROM };
  const ref = async (ctxTail: string): Promise<{ code: number; lines: string[]; state: FakeState }> => {
    const state = betaWorld();
    const lines: string[] = [];
    const code = await main(["beta", "ref"], { ...env, CODE_CTX: `${ctxBase}${ctxTail}` }, { config, switchesFile: fakeSwitches, gates: [integrity], requiredGates: { preflight: [], "change-sets": [], "gateway-live": [], proof: [] }, makePorts: () => makePorts(state, "beta"), out: (line) => lines.push(line) });
    return { code, lines, state };
  };

  it("prints skip for a Cloud tag push, run for a Code push, and writes nothing", async () => {
    const tag = await ref(",trigger:cloud-tag@v0.13.9");
    expect(tag.code).toBe(0);
    expect(JSON.parse(tag.lines.join("\n"))).toMatchObject({ env: "beta", cloud: { tag: "v0.13.9" }, mode: "release", codeRelease: "skip" });
    expect(Object.keys(tag.state.files)).toEqual([]);
    const push = await ref(",trigger:code-push");
    expect(push.code).toBe(0);
    expect(JSON.parse(push.lines.join("\n"))).toMatchObject({ mode: "release", codeRelease: "run" });
    expect(Object.keys(push.state.files)).toEqual([]);
  });
  it("is refused (exit 3, nothing written) with no trigger part, an unproven one, or a pushed tag that is not the resolved tag", async () => {
    for (const tail of ["", ",trigger:unknown", ",trigger:manual", ",trigger:cloud-tag@v0.13.2"]) {
      const result = await ref(tail);
      expect(result.code, tail).toBe(3);
      expect(result.lines.at(-1), tail).toMatch(/^STAGE-FAILED beta ref REFUSED: /u);
      expect(Object.keys(result.state.files), tail).toEqual([]);
    }
  });
});
