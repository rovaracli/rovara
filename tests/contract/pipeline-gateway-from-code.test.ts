// #1478 phase 2: the release pipeline builds and deploys the model gateway from CODE. These tests hold the five points of the design (the image from the Code checkout, the stack from Code's
// CDK app at the Code sha, the gateway's own DeployedCodeSha, the live Cloud sha from the web stack only, rollback by the Code sha recorded with the image), the beta gate (the first
// change set made from Code changes no resource) and the rule for rollback floors written as Cloud shas. No AWS, no network; the floors are also judged with real git.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_RELEASE_CODE_CLONE_STEPS, releaseActionBuildCommands } from "../../infra/lib/cloud-release-actions.js";
import { gate as switchGate } from "../../ops/pipeline/gates/gateway-source-switch.gate.ts";
import { gate as floorGate } from "../../ops/pipeline/gates/rollback-floor.gate.ts";
import { ADDED_OUTPUT, DROPPED_OUTPUTS, judgeGatewaySwitch } from "../../ops/pipeline/lib/gateway-switch.ts";
import { codeShaForBuild, gatewayCodeForRecordedDigest, recordedGateways } from "../../ops/pipeline/lib/gateway-code.ts";
import { cloudFloors, codeFloors, gatewayCodeFloors, judgeGatewayCodeSha, parseFloors } from "../../ops/pipeline/lib/floors.ts";
import { buildLastGood, parseLastGood } from "../../ops/pipeline/lib/lastgood.ts";
import { parseManifest } from "../../ops/pipeline/lib/manifest.ts";
import { liveGatewayCodeSha, readLiveCloudSha } from "../../ops/pipeline/lib/refs.ts";
import { newStageRecord } from "../../ops/pipeline/lib/manifest.ts";
import { captureRollbackRecord } from "../../ops/pipeline/lib/rollback.ts";
import { countRows } from "../../ops/pipeline/lib/changesets.ts";
import { imageStep } from "../../ops/pipeline/steps/image-step.ts";
import { gatewayStep } from "../../ops/pipeline/steps/gateway.ts";
import type { ChangeSetRecord, GateInput, ImageStepInput, ImageStepResult, LastGoodRecord, Manifest, PipelineEnv, Ports } from "../../ops/pipeline/types.ts";
import type { State } from "../../ops/pipeline/lib/run.ts";
import { CODE_REPO, DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, config, makeCtx, makeInputs, makePorts, newState, row, sha, stackFor, withCodeClone } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

const CODE = sha("c");
const OTHER_CODE = sha("d");
const CLOUD_SHA = sha("4");
const NAME = `rovara-pipeline-${EXEC8}`;
const FLOORS_URL = new URL("../../ops/pipeline/rollback-floors.json", import.meta.url);

const manifestOf = (over: { env?: PipelineEnv; mode?: Manifest["mode"]; gateway?: Partial<Manifest["gateway"]>; codeSha?: string | null; release?: "run" | "skip"; pinned?: string | null } = {}): Manifest => {
  const env = over.env ?? "beta";
  return {
    schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-25T12:00:00.000Z", mode: over.mode ?? "release",
    cloud: { tag: "v0.13.10", sha: CLOUD_SHA, ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: sha("3"), production: sha("3") } },
    code: { sha: over.codeSha === undefined ? CODE : over.codeSha, release: over.release ?? "run", requestedRelease: over.release ?? "run", pinnedSha: { beta: over.pinned ?? null, production: over.pinned ?? null }, supersedes: null },
    gateway: { digest: null, source: null, imageTag: null, repository: null, ...over.gateway },
    stages: { [env]: newStageRecord(env, new Date("2026-11-25T12:00:00.000Z"), false) },
  };
};
/** A string matcher typed as a string (vitest's asymmetric matchers are `any`). */
const matching = (pattern: RegExp): string => expect.stringMatching(pattern) as string;
const stateOf = (manifest: Manifest): State => ({ manifest });
const okImage = (digest = DIGEST_A) => (): Promise<ImageStepResult> => Promise.resolve({ digest, source: "built", imageTag: `ctx-${"a".repeat(64)}`, repository: "images" });
const failsWith = async (promise: Promise<unknown>, exitName: string, text?: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  if (text !== undefined) await expect(promise).rejects.toThrow(text);
};
const lastGood = (env: PipelineEnv, over: Partial<LastGoodRecord> = {}): string => JSON.stringify({
  schema: 1, env, recordedAt: "2026-11-24T00:00:00.000Z", executionId: "earlier", mode: "release", cloud: { tag: "v0.13.9", sha: sha("3") }, gateway: { digest: DIGEST_A, codeSha: CODE },
  code: { sha: CODE }, proofGates: [], previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_B, gatewayCodeSha: OTHER_CODE }, ...over,
});

describe("point 1, CloudImage: the gateway image comes from the Code checkout", () => {
  it("beta checks out the Code commit the run releases from the clone (never the Cloud tree), records it as the gateway's Code sha and builds nothing in Cloud", async () => {
    const state = newState({ exec: withCodeClone() });
    const seen: Array<{ codeSha: string | null; code: string | null }> = [];
    const run = (input: ImageStepInput): Promise<ImageStepResult> => { seen.push({ codeSha: input.codeSha, code: input.dirs.code }); return okImage()(); };
    const manifest = manifestOf();
    await imageStep(makeCtx(state, "beta", "image"), stateOf(manifest), run);
    expect(seen).toEqual([{ codeSha: CODE, code: `/work/code-${CODE.slice(0, 12)}` }]);
    expect(manifest.gateway).toMatchObject({ digest: DIGEST_A, source: "built", codeSha: CODE });
    expect(state.calls).toContain(`exec git -C ${CODE_REPO} cat-file -e ${CODE}^{commit}`);
    expect(state.calls).toContain(`exec git -C ${CODE_REPO} worktree add --detach /work/code-${CODE.slice(0, 12)} ${CODE}`);
    // nothing of the Cloud tree is made for the image: no Cloud worktree, no npm ci, no tsc
    expect(state.calls.filter((c) => c.startsWith("git worktree") || c.startsWith("exec bash"))).toEqual([]);
  });

  it("when Code is skipped (a Cloud-only release or a rollback) the gateway comes from the Code that stays: the pinned commit of that environment", async () => {
    const state = newState({ exec: withCodeClone() });
    const manifest = manifestOf({ release: "skip", pinned: OTHER_CODE });
    await imageStep(makeCtx(state, "beta", "image"), stateOf(manifest), okImage());
    expect(manifest.gateway.codeSha).toBe(OTHER_CODE);
    expect(state.calls).toContain(`exec git -C ${CODE_REPO} worktree add --detach /work/code-${OTHER_CODE.slice(0, 12)} ${OTHER_CODE}`);
  });

  it("refuses when the build action gave no Code clone, or the clone does not hold the commit: the gateway is never built from something else", async () => {
    const noClone = newState();
    await failsWith(imageStep(makeCtx(noClone, "beta", "image"), stateOf(manifestOf()), okImage()), "REFUSED", /ROVARA_CODE_REPO is not set/);
    const unknown = newState({ exec: withCodeClone(undefined, () => false) });
    await failsWith(imageStep(makeCtx(unknown, "beta", "image"), stateOf(manifestOf()), okImage()), "REFUSED", /not in the Code clone/);
    const failedAdd = newState({ exec: withCodeClone((cmd, args) => (cmd === "git" && args.includes("worktree") ? { code: 128, stdout: "", stderr: "fatal: bad" } : { code: 0, stdout: "", stderr: "" })) });
    await failsWith(imageStep(makeCtx(failedAdd, "beta", "image"), stateOf(manifestOf()), okImage()), "FAILED", /git worktree add of the Code commit/);
  });

  it("refuses a run that has no Code commit to build from (a Code release with no CODE_SHA; a skipped Code with no pin)", async () => {
    const state = newState({ exec: withCodeClone() });
    await failsWith(imageStep(makeCtx(state, "beta", "image"), stateOf(manifestOf({ codeSha: null })), okImage()), "REFUSED", /Code commit it would come from is not known/);
    await failsWith(imageStep(makeCtx(state, "beta", "image"), stateOf(manifestOf({ release: "skip", pinned: null })), okImage()), "REFUSED", /Code commit it would come from is not known/);
  });

  it("production copies beta's digest and keeps beta's Code commit; with none recorded it refuses", async () => {
    const state = newState({ exec: withCodeClone() });
    const manifest = manifestOf({ env: "production", gateway: { digest: DIGEST_A, source: "built", imageTag: `ctx-${"a".repeat(64)}`, repository: "beta-images", codeSha: OTHER_CODE } });
    const seen: Array<{ codeSha: string | null; code: string | null }> = [];
    await imageStep(makeCtx(state, "production", "image"), stateOf(manifest), (input) => { seen.push({ codeSha: input.codeSha, code: input.dirs.code }); return Promise.resolve({ digest: DIGEST_A, source: "copied", imageTag: `ctx-${"a".repeat(64)}`, repository: "prod-images" }); });
    expect(seen).toEqual([{ codeSha: OTHER_CODE, code: null }]);
    expect(manifest.gateway).toMatchObject({ source: "copied", codeSha: OTHER_CODE });
    const bare = manifestOf({ env: "production", gateway: { digest: DIGEST_A, source: "built", imageTag: null, repository: "beta-images" } });
    await failsWith(imageStep(makeCtx(state, "production", "image"), stateOf(bare), okImage()), "REFUSED", /no Code commit for the gateway to copy/);
  });

  it("an adopted gateway keeps its digest and still gets the Code commit its stack is made from", async () => {
    const state = newState({ exec: withCodeClone() });
    const manifest = manifestOf({ mode: "adoption", gateway: { digest: DIGEST_B, source: "adopted", imageTag: null, repository: null } });
    await imageStep(makeCtx(state, "beta", "image"), stateOf(manifest), () => Promise.reject(new Error("must not run")));
    expect(manifest.gateway.codeSha).toBe(CODE);
  });
});

describe("point 5, rollback: the gateway image is found with the Code sha recorded beside its digest", () => {
  const rollback = (over: Partial<Manifest["gateway"]> = {}): Manifest => manifestOf({ mode: "rollback", release: "skip", pinned: CODE, gateway: over });
  it("a rollback to a recorded digest takes the Code commit recorded with it (last-good, or the record it replaced), not the Code that is live", async () => {
    for (const [digest, recorded] of [[DIGEST_A, CODE], [DIGEST_B, OTHER_CODE]] as const) {
      const state = newState({ exec: withCodeClone() });
      state.ssm["/rovara-cloud/beta/release/last-good"] = lastGood("beta");
      const manifest = rollback();
      await imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: digest } }), stateOf(manifest), okImage(digest));
      expect(manifest.gateway.codeSha).toBe(recorded);
    }
  });

  it("refuses a recorded image that has no Code commit (recorded before the gateway moved to Code) when it is not the image the live gateway runs, and says what is true", async () => {
    const state = newState({ exec: withCodeClone() });
    state.ssm["/rovara-cloud/beta/release/last-good"] = lastGood("beta", { previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_B } });
    await failsWith(imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: DIGEST_B } }), stateOf(rollback()), okImage(DIGEST_B)), "ROLLBACK_REFUSED", /no Code commit for it.*cannot keep it either.*does not exist.*by hand/su);
  });

  it("a digest the last-good record does not name is still refused (the supplied digest is never trusted for its Code commit)", async () => {
    const state = newState({ exec: withCodeClone() });
    state.ssm["/rovara-cloud/beta/release/last-good"] = lastGood("beta");
    await failsWith(imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: `sha256:${"e".repeat(64)}` } }), stateOf(rollback()), okImage()), "ROLLBACK_REFUSED", /not one the beta last-good record names/);
  });

  it("the helpers: the record's gateways in order, and a digest found by value", async () => {
    const record = parseLastGood(lastGood("beta"));
    expect(recordedGateways(record)).toEqual([{ digest: DIGEST_A, codeSha: CODE, which: "last-good" }, { digest: DIGEST_B, codeSha: OTHER_CODE, which: "previous" }]);
    expect(recordedGateways(null)).toEqual([]);
    const ports = makePorts(newState());
    await expect(gatewayCodeForRecordedDigest(ports, config, record, DIGEST_B, "beta")).resolves.toBe(OTHER_CODE);
    await expect(gatewayCodeForRecordedDigest(ports, config, record, `sha256:${"f".repeat(64)}`, "beta")).rejects.toThrow(/not one the beta last-good record names/);
    expect(codeShaForBuild(manifestOf(), "beta")).toBe(CODE);
  });

  it("last-good writes the Code commit beside the digest, and the one it replaced beside the old digest; an older record (none) reads as null", () => {
    const previous = parseLastGood(lastGood("beta"));
    const manifest = manifestOf({ gateway: { digest: DIGEST_B, source: "built", imageTag: null, repository: null, codeSha: CODE } });
    const record = buildLastGood(manifest, "beta", ["p1"], previous, new Date("2026-11-25T13:00:00.000Z"));
    expect(record.gateway).toEqual({ digest: DIGEST_B, codeSha: CODE });
    expect(record.previous).toMatchObject({ gatewayDigest: DIGEST_A, gatewayCodeSha: CODE });
    expect(parseLastGood(JSON.stringify(record)).gateway.codeSha).toBe(CODE);
    const old = parseLastGood(JSON.stringify({ ...JSON.parse(lastGood("beta")) as object, gateway: { digest: DIGEST_A }, previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_B } }));
    expect(old.gateway.codeSha).toBeNull();
    expect(old.previous?.gatewayCodeSha ?? null).toBeNull();
    // a manifest from before phase 2 has no gateway.codeSha, and reads as null
    expect(parseManifest(JSON.stringify({ ...manifestOf(), gateway: { digest: DIGEST_A, source: "built", imageTag: null, repository: null } })).gateway.codeSha).toBeNull();
  });
});

describe("points 2 and 3, CloudGateway: the stack is made by Code's CDK app at the Code sha, and records it as DeployedCodeSha", () => {
  const gatewayManifest = (over: Partial<Manifest["gateway"]> = {}): Manifest => manifestOf({ gateway: { digest: DIGEST_A, source: "built", imageTag: `ctx-${"a".repeat(64)}`, repository: "images", codeSha: CODE, ...over } });
  const world = (): FakeState => {
    const state = newState({ exec: withCodeClone(), plan: { RovaraModelGateway: [row("Modify", "TaskDef", "AWS::ECS::TaskDefinition", "True")] } });
    state.stacks[stackFor("beta", "gateway")] = { status: "UPDATE_COMPLETE", parameters: { ImageDigest: DIGEST_B }, outputs: {}, templateSha: "live", changeSetId: "earlier", lastUpdatedTime: new Date(state.now - 1000).toISOString() };
    return state;
  };

  it("synthesizes in the Code checkout with -c rovaraCodeSha=<the Code sha> and no Cloud sha, after a build that runs without AWS credentials", async () => {
    const state = world();
    await gatewayStep(makeCtx(state, "beta", "gateway"), stateOf(gatewayManifest()));
    const dir = `/work/code-${CODE.slice(0, 12)}`;
    expect(state.cdkRuns).toHaveLength(1);
    expect(state.cdkRuns![0]!.dir).toBe(dir);
    expect(state.cdkRuns![0]!.context).toMatchObject({ rovaraModelGateway: "beta", rovaraCodeSha: CODE });
    expect(state.cdkRuns![0]!.context).not.toHaveProperty("rovaraCloudSha");
    expect(state.cdkRuns![0]!.parameters).toEqual({ ImageDigest: DIGEST_A });
    const builds = (state.execRuns ?? []).filter((r) => r.cmd === "bash");
    expect(builds.map((r) => r.args[1])).toEqual(["npm ci --ignore-scripts --no-audit --no-fund", "npx tsc -b infra"]);
    expect(builds.every((r) => r.cwd === dir && r.awsRemoved)).toBe(true);
    // credential variables removed; the credential files point at /dev/null (not unset: that falls back to ~/.aws) and the instance-metadata lookup is off
    for (const r of builds) {
      expect(r.env).toMatchObject({ AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_CONFIG_FILE: "/dev/null", AWS_EC2_METADATA_DISABLED: "true" });
      for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"]) {
        expect(Object.hasOwn(r.env ?? {}, name) && r.env![name] === undefined, name).toBe(true);
      }
    }
    // no Cloud tree: no Cloud worktree, and no `npm run build:web` etc.
    expect(state.calls.filter((c) => c.startsWith("git worktree"))).toEqual([]);
  });

  it("reuses an existing Code tree only when it is at the Code commit asked for; a tree at another commit is refused, with no build", async () => {
    const dir = `/work/code-${CODE.slice(0, 12)}`;
    const at = (head: string): FakeState => {
      const state = world();
      state.dirs.add(dir);
      state.exec = withCodeClone((cmd, args) => (cmd === "git" && args.includes("rev-parse") ? { code: 0, stdout: `${head}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" }));
      return state;
    };
    const good = at(CODE);
    await gatewayStep(makeCtx(good, "beta", "gateway"), stateOf(gatewayManifest()));
    expect(good.calls.filter((c) => c.includes("worktree add"))).toEqual([]);
    expect(good.cdkRuns).toHaveLength(1);
    const wrong = at(OTHER_CODE);
    await failsWith(gatewayStep(makeCtx(wrong, "beta", "gateway"), stateOf(gatewayManifest())), "REFUSED", /exists but is not at the Code commit cccccccccccc/);
    expect(wrong.cdkRuns ?? []).toEqual([]);
  });

  it("refuses a manifest with no Code commit for the gateway before any build or synth", async () => {
    const state = world();
    await failsWith(gatewayStep(makeCtx(state, "beta", "gateway"), stateOf(gatewayManifest({ codeSha: null }))), "REFUSED", /no Code commit for the gateway/);
    expect(state.cdkRuns ?? []).toEqual([]);
    expect(state.execRuns ?? []).toEqual([]);
  });

  it("a failed install in the Code tree stops the step, and the gates of the phase get no Cloud tree", async () => {
    const state = world();
    state.exec = withCodeClone((cmd, args) => (cmd === "bash" && String(args[1]).startsWith("npm ci") ? { code: 1, stdout: "", stderr: "ERESOLVE" } : { code: 0, stdout: "", stderr: "" }));
    await failsWith(gatewayStep(makeCtx(state, "beta", "gateway"), stateOf(gatewayManifest())), "FAILED", /the Code build command "npm ci/);
    expect(state.cdkRuns ?? []).toEqual([]);
    let seenDirs: unknown;
    const ok = world();
    const probe = { name: "probe", phases: ["change-sets"] as const, run: (input: GateInput) => { seenDirs = input.dirs.cloud; return Promise.resolve({ result: "pass" as const }); } };
    await gatewayStep(makeCtx(ok, "beta", "gateway", { gates: [probe], required: { preflight: [], "change-sets": ["probe"], "gateway-live": [], proof: [] } }), stateOf(gatewayManifest()));
    expect(seenDirs).toBeNull();
  });
});

describe("point 4, Cloud's live sha: read from the web stack only", () => {
  it("a gateway stamped with a Cloud sha (written by the earlier pipeline) says nothing about which Cloud is live", async () => {
    const state = newState();
    state.stacks[stackFor("beta", "gateway")] = { status: "UPDATE_COMPLETE", parameters: {}, outputs: { DeployedCloudSha: sha("3") }, templateSha: "g" };
    const ports = makePorts(state);
    expect((await readLiveCloudSha(ports, stackFor("beta", "web")))).toEqual({ sha: null, warnings: [expect.stringMatching(/no DeployedCloudSha output on the web stack/)] });
    state.stacks[stackFor("beta", "web")] = { status: "UPDATE_COMPLETE", parameters: {}, outputs: { DeployedCloudSha: sha("2") }, templateSha: "w" };
    expect(await readLiveCloudSha(ports, stackFor("beta", "web"))).toEqual({ sha: sha("2"), warnings: [] });
  });

  it("the rollback record captured in preflight names the Code commit the live gateway was deployed from (null for a gateway Cloud deployed)", async () => {
    const state = newState();
    state.stacks[stackFor("beta", "gateway")] = { status: "UPDATE_COMPLETE", parameters: { ImageDigest: DIGEST_A }, outputs: { DeployedCodeSha: CODE }, templateSha: "g" };
    expect((await captureRollbackRecord(makePorts(state), config, "beta", makeInputs(), null)).gateway).toEqual({ digest: DIGEST_A, codeSha: CODE });
    state.stacks[stackFor("beta", "gateway")]!.outputs = { DeployedCloudSha: sha("3") };
    expect((await captureRollbackRecord(makePorts(state), config, "beta", makeInputs(), null)).gateway).toEqual({ digest: DIGEST_A, codeSha: null });
  });

  it("the gateway's own record is its DeployedCodeSha: a 40-hex commit, else none", () => {
    expect(liveGatewayCodeSha({ DeployedCodeSha: CODE })).toBe(CODE);
    expect(liveGatewayCodeSha({ DeployedCodeSha: "main" })).toBeNull();
    expect(liveGatewayCodeSha({ DeployedCloudSha: sha("3") })).toBeNull();
  });
});

describe("the beta gate: the first change set made from Code changes no resource", () => {
  type Doc = Record<string, Record<string, unknown>>;
  const live: Doc = {
    Parameters: { ImageDigest: { Type: "String" } },
    Conditions: { CDKMetadataAvailable: { "Fn::Equals": [1, 1] } },
    Resources: { Meter: { Type: "AWS::DynamoDB::GlobalTable", Properties: { Name: "m" } }, ServeTask: { Type: "AWS::ECS::TaskDefinition", Properties: { Image: { Ref: "ImageDigest" } } } },
    Outputs: { AlarmTopic: { Value: "t" }, ServiceArn: { Value: "arn:svc" }, DeployedCloudSha: { Value: sha("3"), Description: "cloud" } },
  };
  const next = (edit: (t: Doc) => void = () => undefined): unknown => {
    const copy = structuredClone(live);
    delete copy.Outputs!.DeployedCloudSha;
    copy.Outputs![ADDED_OUTPUT] = { Value: CODE, Description: "code" };
    edit(copy);
    return copy;
  };

  it("passes when the templates are equal except that DeployedCloudSha is replaced by DeployedCodeSha", () => {
    expect(judgeGatewaySwitch(live, next(), CODE)).toEqual({ failures: [] });
    expect(DROPPED_OUTPUTS).toEqual(["DeployedCloudSha"]);
  });

  it("fails on a changed, added or removed resource, and names it", () => {
    expect(judgeGatewaySwitch(live, next((t) => { (t.Resources!.ServeTask as Record<string, unknown>).Properties = { Image: "x" }; }), CODE).failures.join("\n")).toMatch(/Resources: changed ServeTask/);
    expect(judgeGatewaySwitch(live, next((t) => { t.Resources!.Extra = { Type: "AWS::SNS::Topic" }; }), CODE).failures.join("\n")).toMatch(/Resources: added Extra/);
    expect(judgeGatewaySwitch(live, next((t) => { delete t.Resources!.Meter; }), CODE).failures.join("\n")).toMatch(/Resources: removed Meter/);
  });

  it("fails on a changed parameter, condition or rule, and on a section that appears or goes", () => {
    expect(judgeGatewaySwitch(live, next((t) => { t.Parameters!.ImageDigest = { Type: "Number" }; }), CODE).failures.join("\n")).toMatch(/Parameters: changed ImageDigest/);
    expect(judgeGatewaySwitch(live, next((t) => { t.Conditions!.CDKMetadataAvailable = { "Fn::Equals": [1, 2] }; }), CODE).failures.join("\n")).toMatch(/Conditions: changed/);
    expect(judgeGatewaySwitch(live, next((t) => { t.Rules = { A: {} }; }), CODE).failures.join("\n")).toMatch(/section Rules differs/);
  });

  it("fails when an output other than DeployedCloudSha goes, one other than DeployedCodeSha comes, or a kept one changes", () => {
    expect(judgeGatewaySwitch(live, next((t) => { delete t.Outputs!.ServiceArn; }), CODE).failures.join("\n")).toMatch(/drops the output\(s\) ServiceArn/);
    expect(judgeGatewaySwitch(live, next((t) => { t.Outputs!.Another = { Value: "x" }; }), CODE).failures.join("\n")).toMatch(/adds the output\(s\) Another/);
    expect(judgeGatewaySwitch(live, next((t) => { t.Outputs!.AlarmTopic = { Value: "other" }; }), CODE).failures.join("\n")).toMatch(/alters the output\(s\) AlarmTopic/);
  });

  it("fails when DeployedCodeSha is missing, malformed, or names another commit than the gateway is built from; a non-object template cannot be judged", () => {
    expect(judgeGatewaySwitch(live, next((t) => { delete t.Outputs![ADDED_OUTPUT]; }), CODE).failures.join("\n")).toMatch(/no DeployedCodeSha output/);
    expect(judgeGatewaySwitch(live, next((t) => { t.Outputs![ADDED_OUTPUT] = { Value: "head" }; }), CODE).failures.join("\n")).toMatch(/no DeployedCodeSha output with a 40-hex/);
    expect(judgeGatewaySwitch(live, next(), OTHER_CODE).failures.join("\n")).toMatch(/DeployedCodeSha says cccccccccccc, not the Code commit dddddddddddd/);
    expect(judgeGatewaySwitch("{}", next(), CODE).failures[0]).toMatch(/not a JSON object/);
  });

  const record = (over: Partial<ChangeSetRecord> = {}): ChangeSetRecord => ({
    part: "gateway", stack: stackFor("beta", "gateway"), changeSetName: NAME, changeSetId: "cs-1", noChanges: false, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", templateSha256: "h",
    rows: [row("Modify", "ServeTask", "AWS::ECS::TaskDefinition", "True")], counts: countRows([]), previewedAt: "x", executedAt: null, finalStatus: null, ...over,
  });
  const gateInput = (state: FakeState, records: ChangeSetRecord[], codeSha: string | null = CODE): GateInput => ({
    env: "beta", phase: "change-sets", region: "us-east-1", config, manifest: manifestOf({ gateway: { digest: DIGEST_A, source: "built", imageTag: null, repository: null, codeSha } }), changeSets: records,
    dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports: makePorts(state), log: () => undefined,
  });
  const switchWorld = (outputs: Record<string, string>, liveDigest: string = DIGEST_B): FakeState => {
    const state = newState();
    state.stacks[stackFor("beta", "gateway")] = { status: "UPDATE_COMPLETE", parameters: { ImageDigest: liveDigest }, outputs, templateSha: "live" };
    state.templates = { [`live:${stackFor("beta", "gateway")}`]: live, [`cs:${stackFor("beta", "gateway")}/${NAME}`]: next() };
    return state;
  };

  it("the gate passes the first Code-made change set when only the outputs differ", async () => {
    const outcome = await switchGate.run(gateInput(switchWorld({ DeployedCloudSha: sha("3") }), [record()]));
    expect(outcome.result).toBe("pass");
    expect(outcome.notes?.join(" ")).toMatch(/changes no resource/);
  });

  it("with the SAME image (live ImageDigest = this run's digest) the change set must have no row at all: a row means a stack-level property outside the template changed (tags, role, termination protection)", async () => {
    const same = await switchGate.run(gateInput(switchWorld({ DeployedCloudSha: sha("3") }, DIGEST_A), [record()]));
    expect(same.result).toBe("fail");
    expect(same.failures?.join(" ")).toMatch(/image is unchanged .* must have no resource row, but it has 1: something outside the template changed/u);
    // an outputs-only change set (no row) with the same image passes, and the rows of a NEW image are the image rows the template comparison already covers
    expect((await switchGate.run(gateInput(switchWorld({ DeployedCloudSha: sha("3") }, DIGEST_A), [record({ rows: [] })]))).result).toBe("pass");
    expect((await switchGate.run(gateInput(switchWorld({ DeployedCloudSha: sha("3") }, DIGEST_B), [record()]))).result).toBe("pass");
  });

  it("when the live stack has no ServiceArn (a hand deploy without the sha context drops DeployedCloudSha and ServiceArn) the refusal NAMES the cause and the way out", async () => {
    const state = switchWorld({}, DIGEST_B);
    const handDeployed = structuredClone(live);
    delete handDeployed.Outputs!.ServiceArn;
    delete handDeployed.Outputs!.DeployedCloudSha;
    state.templates![`live:${stackFor("beta", "gateway")}`] = handDeployed;
    const outcome = await switchGate.run(gateInput(state, [record()]));
    expect(outcome.result).toBe("fail");
    expect(outcome.failures?.join(" ")).toMatch(/the change adds the output\(s\) ServiceArn.*deployed by hand without the sha context.*-c rovaraCloudSha=<the 40-hex Cloud commit>.*-c rovaraCodeSha=<the 40-hex Code commit>/su);
  });

  it("the gate FAILS the step when the Code-made template differs from the live one in a resource", async () => {
    const state = switchWorld({ DeployedCloudSha: sha("3") });
    state.templates![`cs:${stackFor("beta", "gateway")}/${NAME}`] = next((t) => { (t.Resources!.Meter as Record<string, unknown>).Properties = { Name: "renamed" }; });
    const outcome = await switchGate.run(gateInput(state, [record()]));
    expect(outcome.result).toBe("fail");
    expect(outcome.failures?.join("\n")).toMatch(/outside the Outputs \(Resources: changed Meter\)/);
  });

  it("the gate fails closed: no Code commit in the manifest, an unreadable live template", async () => {
    expect((await switchGate.run(gateInput(switchWorld({ DeployedCloudSha: sha("3") }), [record()], null))).failures?.[0]).toMatch(/names no Code commit/);
    const state = switchWorld({ DeployedCloudSha: sha("3") });
    delete state.templates![`live:${stackFor("beta", "gateway")}`];
    expect((await switchGate.run(gateInput(state, [record()]))).failures?.[0]).toMatch(/live template .* cannot be read/);
  });

  it("the gate steps aside once the stack is Code's (it has a DeployedCodeSha), when there is no gateway change set, or no stack; and passes an empty change set", async () => {
    expect(await switchGate.run(gateInput(switchWorld({ DeployedCodeSha: OTHER_CODE }), [record()]))).toMatchObject({ result: "skipped", skippedReason: matching(/already deployed from Code \(dddddddddddd\)/) });
    expect(await switchGate.run(gateInput(switchWorld({}), [record({ part: "web" })]))).toMatchObject({ result: "skipped" });
    expect(await switchGate.run(gateInput(newState(), [record()]))).toMatchObject({ result: "skipped", skippedReason: matching(/does not exist/) });
    expect((await switchGate.run(gateInput(switchWorld({ DeployedCloudSha: sha("3") }), [record({ noChanges: true, changeSetId: null, templateSha256: null, rows: [] })]))).result).toBe("pass");
  });

  it("the gate is required for the change-sets phase (a missing gate stops the step with exit 21)", () => {
    const policy = JSON.parse(readFileSync(new URL("../../ops/pipeline/gate-policy.json", import.meta.url), "utf8")) as { required: Record<string, string[]> };
    expect(policy.required["change-sets"]).toContain("gateway-source-switch");
  });
});

describe("rollback floors written as Cloud shas", () => {
  const raw = readFileSync(FLOORS_URL, "utf8");
  const floors = parseFloors(raw);

  it("every gateway floor has a gatewayCode counterpart that names it, and the two groups are never judged against the wrong repository", () => {
    const gateway = floors.floors.filter((f) => f.group === "gateway");
    expect(gateway.length).toBeGreaterThan(0);
    for (const floor of gateway) {
      const counterpart = gatewayCodeFloors(floors).filter((c) => c.reason.includes(`gateway floor ${floor.sha!.slice(0, 8)}`));
      expect(counterpart, `gateway floor ${floor.sha}`).toHaveLength(1);
    }
    expect(gatewayCodeFloors(floors)).toHaveLength(gateway.length);
    for (const floor of gatewayCodeFloors(floors)) expect(floor.sha).toMatch(/^[0-9a-f]{40}$/u);
    // the Cloud ref is judged against the Cloud-sha groups only, the Code rollback target against `code` only
    expect(cloudFloors(floors).some((f) => f.group === "gatewayCode" || f.group === "code")).toBe(false);
    expect(codeFloors(floors).some((f) => f.group === "gatewayCode")).toBe(false);
    // the Cloud rows stay in force
    expect(cloudFloors(floors).filter((f) => f.group === "gateway").map((f) => f.sha)).toEqual(gateway.map((f) => f.sha));
  });

  /** Real git: floor F, then C1 (a descendant of F), and U (a root commit: no ancestor in common). */
  const repo = ((): { dir: string; floor: string; above: string; below: string } => {
    const dir = mkdtempSync(join(tmpdir(), "gw-floor-"));
    const git = (...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a"), "1");
    git("add", "a");
    git("commit", "-q", "-m", "floor");
    const floor = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a"), "2");
    git("commit", "-q", "-am", "above");
    const above = git("rev-parse", "HEAD");
    git("checkout", "-q", "--orphan", "other");
    writeFileSync(join(dir, "b"), "x");
    git("add", "b");
    git("commit", "-q", "-m", "below");
    return { dir, floor, above, below: git("rev-parse", "HEAD") };
  })();
  const realExec: Ports["exec"] = (cmd, args) => { const r = spawnSync(cmd, [...args], { encoding: "utf8" }); return Promise.resolve({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }); };
  const floorsWith = (...shas: string[]): ReturnType<typeof parseFloors> => parseFloors(JSON.stringify({ schema: 1, floors: { gatewayCode: shas.map((sha) => ({ sha, reason: `needs ${sha.slice(0, 7)}` })) } }));
  const portsWith = (): Ports => ({ ...makePorts(newState()), exec: realExec });

  it("a gateway built from the floor commit or a descendant passes; one built from another line of history is below the floor, with the floor's reason", async () => {
    const f = floorsWith(repo.floor);
    expect((await judgeGatewayCodeSha(portsWith(), f, repo.dir, repo.floor)).failures).toEqual([]);
    expect((await judgeGatewayCodeSha(portsWith(), f, repo.dir, repo.above)).failures).toEqual([]);
    const below = await judgeGatewayCodeSha(portsWith(), f, repo.dir, repo.below);
    expect(below.failures).toHaveLength(1);
    expect(below.failures[0]).toMatch(new RegExp(`below the gatewayCode floor ${repo.floor.slice(0, 12)}: needs ${repo.floor.slice(0, 7)}`, "u"));
  });

  it("fails closed: no clone while a floor exists, a commit or a floor the clone does not hold, an unusable floor; no floors is a note", async () => {
    const f = floorsWith(repo.floor);
    expect((await judgeGatewayCodeSha(portsWith(), f, null, repo.above)).failures[0]).toMatch(/no Code clone/);
    expect((await judgeGatewayCodeSha(portsWith(), f, repo.dir, sha("9"))).failures[0]).toMatch(/is not in the Code clone/);
    expect((await judgeGatewayCodeSha(portsWith(), floorsWith(sha("8")), repo.dir, repo.above)).failures[0]).toMatch(/floor 8{12} is not in the Code clone/);
    expect((await judgeGatewayCodeSha(portsWith(), floorsWith("abc123"), repo.dir, repo.above)).failures[0]).toMatch(/not a full 40-hex sha/);
    const none = await judgeGatewayCodeSha(portsWith(), parseFloors(JSON.stringify({ schema: 1, floors: {} })), null, repo.above);
    expect(none.failures).toEqual([]);
    expect(none.notes[0]).toMatch(/lists no gatewayCode floors/);
  });

  const floorInput = (state: FakeState, floorsText: string, codeSha: string | null, withGatewaySet = true): GateInput => {
    state.files["/p/ops/pipeline/rollback-floors.json"] = floorsText;
    const m = manifestOf({ gateway: { digest: DIGEST_A, source: "built", imageTag: null, repository: null, codeSha } });
    return { env: "beta", phase: "change-sets", region: "us-east-1", config, manifest: m, changeSets: withGatewaySet ? [{ part: "gateway", stack: "s", changeSetName: NAME, changeSetId: "x", noChanges: false, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", templateSha256: "h", rows: [], counts: countRows([]), previewedAt: "x", executedAt: null, finalStatus: null }] : [], dirs: { pipeline: "/p", cloud: null, out: "/o", work: "/w" }, ports: { ...makePorts(state), exec: (cmd, args) => (cmd === "printenv" ? Promise.resolve({ code: 0, stdout: `${repo.dir}\n`, stderr: "" }) : realExec(cmd, args)) }, log: () => undefined };
  };
  const floorsText = JSON.stringify({ schema: 1, floors: { gatewayCode: [{ sha: repo.floor, reason: "needs the floor" }] } });

  it("the rollback-floor gate judges the gateway's Code commit with the gateway change set, and not without one", async () => {
    expect((await floorGate.run(floorInput(newState(), floorsText, repo.above))).result).toBe("pass");
    const low = await floorGate.run(floorInput(newState(), floorsText, repo.below));
    expect(low.result).toBe("fail");
    expect(low.failures?.join(" ")).toMatch(/below the gatewayCode floor .*needs the floor/);
    expect((await floorGate.run(floorInput(newState(), floorsText, null))).failures?.[0]).toMatch(/names no Code commit for the gateway/);
    expect((await floorGate.run(floorInput(newState(), floorsText, repo.below, false))).result).toBe("skipped");
  });

  it("the real floors file: the gateway's first Code commits are at or above both rows in this repository's pinned history only through the Code clone (the rows are 40-hex Code commits)", () => {
    expect(gatewayCodeFloors(floors).map((f) => f.sha)).toEqual(["d531e8357c4056a9d2a7e54776deecc541971f42", "5e6c41b127a3be962f8e9790f98dc6420b0f3c1e"]);
  });
});

describe("the release actions: the steps that need the Code clone", () => {
  it("image and gateway join preflight and gateway-check: the build refuses to start them without the Source input, in both projects", () => {
    expect([...CLOUD_RELEASE_CODE_CLONE_STEPS]).toEqual(["preflight", "image", "gateway", "gateway-check"]);
    for (const environment of ["beta", "production"] as const) {
      const guard = releaseActionBuildCommands(environment).find((line) => line.includes("no Code clone"))!;
      expect(guard).toContain("preflight|image|gateway|gateway-check");
    }
  });
});
