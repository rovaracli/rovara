// #1478 phase 2 pre-review fix (MUST-2 / SHOULD-1): the pipeline can KEEP the gateway that runs now. When a gateway image is recorded without a Code commit (before the gateway moved to
// Code) and it is exactly the image the live gateway stack runs, and that stack was last deployed from Cloud (no DeployedCodeSha), the gateway change set is skipped, so a web-only rollback
// works with pre-change last-good records. Every other pre-change image is still refused. No AWS, no network.
import { describe, expect, it } from "vitest";
import { FLOORS_PATH } from "../../ops/pipeline/lib/floors.ts";
import { gatewayCodeForRecordedDigest, keepsLiveGateway } from "../../ops/pipeline/lib/gateway-code.ts";
import { parseLastGood } from "../../ops/pipeline/lib/lastgood.ts";
import { newStageRecord } from "../../ops/pipeline/lib/manifest.ts";
import type { State } from "../../ops/pipeline/lib/run.ts";
import { gatewayStep } from "../../ops/pipeline/steps/gateway.ts";
import { imageStep } from "../../ops/pipeline/steps/image-step.ts";
import type { ImageStepInput, ImageStepResult, Manifest, PipelineEnv } from "../../ops/pipeline/types.ts";
import { DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, config, liveStack, makeCtx, makePorts, newState, sha, stackFor, withCodeClone } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

const CODE = sha("c");
const CLOUD_SHA = sha("4");
const BELOW = `sha256:${"c".repeat(64)}`;
const FLOORS = JSON.stringify({ schema: 1, floors: {}, gatewayDigests: { belowFloor: [{ digest: BELOW, reason: "no price bands" }] } });

const manifestOf = (env: PipelineEnv, mode: Manifest["mode"], gateway: Partial<Manifest["gateway"]> = {}): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-25T12:00:00.000Z", mode,
  cloud: { tag: "v0.13.10", sha: CLOUD_SHA, ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: sha("3"), production: sha("3") } },
  code: { sha: CODE, release: mode === "rollback" ? "skip" : "run", requestedRelease: mode === "rollback" ? "skip" : "run", pinnedSha: { beta: mode === "rollback" ? CODE : null, production: mode === "rollback" ? CODE : null }, supersedes: null },
  gateway: { digest: null, source: null, imageTag: null, repository: null, ...gateway },
  stages: { [env]: newStageRecord(env, new Date("2026-11-25T12:00:00.000Z"), false) },
});
const stateOf = (manifest: Manifest): State => ({ manifest });
/** A last-good record of `env` written before the gateway moved to Code: no Code commit beside the digest (current and previous). */
const preChange = (env: PipelineEnv, over: Record<string, unknown> = {}): string => JSON.stringify({
  schema: 1, env, recordedAt: "2026-11-24T00:00:00.000Z", executionId: "earlier", mode: "release", cloud: { tag: "v0.13.9", sha: sha("3") }, gateway: { digest: DIGEST_A },
  code: { sha: CODE }, proofGates: [], previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_B }, ...over,
});
const failsWith = async (promise: Promise<unknown>, exitName: string, text: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  await expect(promise).rejects.toThrow(text);
};
/** The world: `env`'s live gateway stack runs `running` (with `outputs`), its last-good record is `record`, the floors file is in the pipeline tree. */
function world(env: PipelineEnv, record: string | null, running: string | null, outputs: Record<string, string> = {}): FakeState {
  const state = newState({ exec: withCodeClone(), files: { [`/pipeline/${FLOORS_PATH}`]: FLOORS } });
  if (record !== null) state.ssm[`/rovara-cloud/${env}/release/last-good`] = record;
  if (running !== null) liveStack(state, stackFor(env, "gateway"), { parameters: { ImageDigest: running }, outputs });
  return state;
}
const supplied = (digest: string, seen: ImageStepInput[] = []) => (input: ImageStepInput): Promise<ImageStepResult> => {
  seen.push(input);
  return Promise.resolve({ digest, source: "supplied", imageTag: `ctx-${"a".repeat(64)}`, repository: "images" });
};
const noCdk = (state: FakeState): void => { expect(state.cdkRuns ?? []).toEqual([]); expect(state.execRuns ?? []).toEqual([]); };

describe("keepsLiveGateway: the live stack runs exactly this image and was last deployed from Cloud", () => {
  it("keeps when ImageDigest equals the digest and there is no DeployedCodeSha output", async () => {
    expect(await keepsLiveGateway(makePorts(world("beta", null, DIGEST_A)), config, "beta", DIGEST_A)).toEqual({ keep: true });
  });

  it("does not keep a different digest, a missing stack, a stack without an ImageDigest parameter, or a stack already deployed from Code", async () => {
    const other = await keepsLiveGateway(makePorts(world("beta", null, DIGEST_B)), config, "beta", DIGEST_A);
    expect(other).toMatchObject({ keep: false, why: expect.stringMatching(/runs sha256:[0-9a-f]{12}.*not that image/u) as string });
    expect(await keepsLiveGateway(makePorts(world("beta", null, null)), config, "beta", DIGEST_A)).toMatchObject({ keep: false, why: expect.stringMatching(/does not exist/u) as string });
    const bare = world("beta", null, DIGEST_A);
    delete bare.stacks[stackFor("beta", "gateway")]!.parameters.ImageDigest;
    expect(await keepsLiveGateway(makePorts(bare), config, "beta", DIGEST_A)).toMatchObject({ keep: false, why: expect.stringMatching(/no image digest/u) as string });
    expect(await keepsLiveGateway(makePorts(world("beta", null, DIGEST_A, { DeployedCodeSha: CODE })), config, "beta", DIGEST_A)).toMatchObject({ keep: false, why: expect.stringMatching(/already deployed from Code/u) as string });
  });

  it("a DeployedCodeSha that is present but not a 40-hex commit is NOT read as 'deployed from Cloud': it is not kept (pinned)", async () => {
    for (const bad of ["", "not-a-sha", CODE.toUpperCase(), CODE.slice(0, 39), `${CODE}0`]) {
      expect(await keepsLiveGateway(makePorts(world("beta", null, DIGEST_A, { DeployedCodeSha: bad })), config, "beta", DIGEST_A), JSON.stringify(bad)).toMatchObject({ keep: false, why: expect.stringMatching(/not a 40-hex commit/u) as string });
    }
  });
});

describe("gatewayCodeForRecordedDigest: a recorded Code commit wins; none recorded = keep (null) or refuse", () => {
  it("returns the recorded Code commit without looking at the live stack, and prefers the entry that has one when last-good and previous name the same image", async () => {
    const withCode = parseLastGood(preChange("beta", { gateway: { digest: DIGEST_A, codeSha: CODE }, previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_A } }));
    expect(await gatewayCodeForRecordedDigest(makePorts(world("beta", null, null)), config, withCode, DIGEST_A, "beta")).toBe(CODE);
    const later = parseLastGood(preChange("beta", { gateway: { digest: DIGEST_A }, previous: { cloudTag: "v0.13.2", cloudSha: sha("2"), gatewayDigest: DIGEST_A, gatewayCodeSha: sha("b") } }));
    expect(await gatewayCodeForRecordedDigest(makePorts(world("beta", null, null)), config, later, DIGEST_A, "beta")).toBe(sha("b"));
  });

  it("a record whose codeSha is not a 40-hex commit reads as pre-change (never used as a commit): it keeps the live image, and is refused otherwise", async () => {
    const odd = parseLastGood(preChange("beta", { gateway: { digest: DIGEST_A, codeSha: "not-a-commit" } }));
    expect(await gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_A)), config, odd, DIGEST_A, "beta")).toBeNull();
    await failsWith(gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_B)), config, odd, DIGEST_A, "beta"), "ROLLBACK_REFUSED", /no Code commit for it/u);
  });

  it("pre-change record + the live image = null (keep); pre-change record + another live image = refused", async () => {
    const record = parseLastGood(preChange("beta"));
    expect(await gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_A)), config, record, DIGEST_A, "beta")).toBeNull();
    expect(await gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_A, { DeployedCodeSha: CODE })), config, record, DIGEST_A, "beta")).toBe(CODE);
    await failsWith(gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_A, { DeployedCodeSha: "head" })), config, record, DIGEST_A, "beta"), "ROLLBACK_REFUSED", /not a 40-hex commit/u);
    await failsWith(gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_B)), config, record, DIGEST_A, "beta"), "ROLLBACK_REFUSED", /no Code commit for it.*not that image/u);
    await failsWith(gatewayCodeForRecordedDigest(makePorts(world("beta", null, DIGEST_B)), config, record, DIGEST_A, "beta", "release"), "REFUSED", /no Code commit for it.*not that image/u);
  });
});

describe("a rollback of the web side with pre-change last-good records: the image step keeps the live gateway and the gateway step makes no change set", () => {
  const rollbackBeta = (): { state: FakeState; manifest: Manifest } => ({ state: world("beta", preChange("beta"), DIGEST_A), manifest: manifestOf("beta", "rollback") });

  it("pre-change last-good + the same digest as the live ImageDigest (no DeployedCodeSha): the image step records no Code commit, builds no tree; the gateway step skips and proceeds", async () => {
    const { state, manifest } = rollbackBeta();
    const seen: ImageStepInput[] = [];
    await imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifest), supplied(DIGEST_A, seen));
    expect(manifest.gateway).toMatchObject({ digest: DIGEST_A, source: "supplied" });
    expect(manifest.gateway.codeSha ?? null).toBeNull();
    expect(seen.map((s) => ({ codeSha: s.codeSha, code: s.dirs.code }))).toEqual([{ codeSha: null, code: null }]);
    expect(state.calls.some((c) => c.includes("worktree add"))).toBe(false);
    expect(manifest.stages.beta!.warnings.join(" ")).toMatch(/kept as it runs/u);
    // the gateway step: no Code build, no cdk, no gateway change set, no gate asked for one
    await gatewayStep(makeCtx(state, "beta", "gateway"), stateOf(manifest));
    noCdk(state);
    expect(manifest.stages.beta!.changeSets.filter((cs) => cs.part === "gateway")).toEqual([]);
    expect(manifest.stages.beta!.warnings.join(" ")).toMatch(/gateway was kept as it runs.*no gateway change set was made/u);
    expect(state.calls.filter((c) => c.startsWith("cdk "))).toEqual([]);
  });

  it("a different digest (the live gateway runs another image) is still refused, by the image step and by the gateway step", async () => {
    const state = world("beta", preChange("beta"), DIGEST_B);
    await failsWith(imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf("beta", "rollback")), supplied(DIGEST_A)), "ROLLBACK_REFUSED", /no Code commit for it.*not that image/u);
    // a manifest that reached the gateway step with no Code commit (a stale or hand-made one) is judged on the live stack again
    const manifest = manifestOf("beta", "rollback", { digest: DIGEST_A, source: "supplied", imageTag: null, repository: "images" });
    await failsWith(gatewayStep(makeCtx(state, "beta", "gateway"), stateOf(manifest)), "REFUSED", /no Code commit for the gateway.*cannot be kept.*not that image/u);
    noCdk(state);
  });

  it("a live DeployedCodeSha that is malformed (not 40-hex) refuses the keep, in both steps", async () => {
    const state = world("beta", preChange("beta"), DIGEST_A, { DeployedCodeSha: "garbage" });
    await failsWith(imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf("beta", "rollback")), supplied(DIGEST_A)), "ROLLBACK_REFUSED", /not a 40-hex commit/u);
    const manifest = manifestOf("beta", "rollback", { digest: DIGEST_A, source: "supplied", imageTag: null, repository: "images" });
    await failsWith(gatewayStep(makeCtx(state, "beta", "gateway"), stateOf(manifest)), "REFUSED", /cannot be kept.*not a 40-hex commit/u);
    noCdk(state);
  });

  it("a stack already deployed from Code (a switch run that failed before last-good was written) runs the same image: the Code commit it attests is used, so the rollback proceeds with a no-op gateway change set", async () => {
    const state = world("beta", preChange("beta"), DIGEST_A, { DeployedCodeSha: CODE });
    const manifest = manifestOf("beta", "rollback");
    const seen: ImageStepInput[] = [];
    await imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifest), supplied(DIGEST_A, seen));
    expect(manifest.gateway).toMatchObject({ digest: DIGEST_A, source: "supplied", codeSha: CODE });
    expect(seen.map((s) => s.codeSha)).toEqual([CODE]);
    expect(manifest.stages.beta!.warnings.join(" ")).not.toMatch(/kept as it runs/u);
  });

  it("... but a DeployedCodeSha that is not 40-hex, or a stack running another image, is still refused", async () => {
    const bad = world("beta", preChange("beta"), DIGEST_A, { DeployedCodeSha: "not-a-sha" });
    await failsWith(imageStep(makeCtx(bad, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf("beta", "rollback")), supplied(DIGEST_A)), "ROLLBACK_REFUSED", /not a 40-hex commit/u);
    const other = world("beta", preChange("beta"), DIGEST_B, { DeployedCodeSha: CODE });
    await failsWith(imageStep(makeCtx(other, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf("beta", "rollback")), supplied(DIGEST_A)), "ROLLBACK_REFUSED", /not that image/u);
  });

  it("a digest the last-good record does not name is refused before the live stack is asked", async () => {
    const state = world("beta", preChange("beta"), `sha256:${"e".repeat(64)}`);
    await failsWith(imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: `sha256:${"e".repeat(64)}` } }), stateOf(manifestOf("beta", "rollback")), supplied(`sha256:${"e".repeat(64)}`)), "ROLLBACK_REFUSED", /not one the beta last-good record names/u);
  });

  it("keeping a digest the floors file lists below the floor is refused (the digest is judged in the image step because no gateway change set is made)", async () => {
    const state = world("beta", preChange("beta", { gateway: { digest: BELOW } }), BELOW);
    await failsWith(imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: BELOW } }), stateOf(manifestOf("beta", "rollback")), supplied(BELOW)), "ROLLBACK_REFUSED", /cannot be kept.*no price bands/u);
    const missing = world("beta", preChange("beta"), DIGEST_A);
    delete missing.files[`/pipeline/${FLOORS_PATH}`];
    await failsWith(imageStep(makeCtx(missing, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf("beta", "rollback")), supplied(DIGEST_A)), "REFUSED", /missing from the pipeline tree/u);
  });

  it("a release run that names the live pre-change digest keeps it too (REFUSED, not ROLLBACK_REFUSED, when it cannot)", async () => {
    const ok = world("beta", preChange("beta"), DIGEST_A);
    const manifest = manifestOf("beta", "release");
    await imageStep(makeCtx(ok, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifest), supplied(DIGEST_A));
    expect(manifest.gateway.codeSha ?? null).toBeNull();
    const other = world("beta", preChange("beta"), DIGEST_B);
    await failsWith(imageStep(makeCtx(other, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf("beta", "release")), supplied(DIGEST_A)), "REFUSED", /no Code commit for it.*not that image/u);
  });
});

describe("production: a rollback and a release that follow a kept gateway", () => {
  const copied = (digest: string) => (): Promise<ImageStepResult> => Promise.resolve({ digest, source: "copied", imageTag: `ctx-${"a".repeat(64)}`, repository: "prod-images" });
  const beta = { digest: DIGEST_A, source: "supplied" as const, imageTag: null, repository: "beta-images", codeSha: null };

  it("a production rollback uses production's own record and live stack (pre-change record + the image production runs: kept; another image: refused)", async () => {
    const state = world("production", preChange("production"), DIGEST_A);
    const manifest = manifestOf("production", "rollback", beta);
    await imageStep(makeCtx(state, "production", "image"), stateOf(manifest), copied(DIGEST_A));
    expect(manifest.gateway.codeSha ?? null).toBeNull();
    const other = world("production", preChange("production"), DIGEST_B);
    await failsWith(imageStep(makeCtx(other, "production", "image"), stateOf(manifestOf("production", "rollback", beta)), copied(DIGEST_A)), "ROLLBACK_REFUSED", /not that image/u);
  });

  it("a production release copies beta's kept digest (no Code commit) only when production runs that image from Cloud; otherwise it is refused as before", async () => {
    const state = world("production", null, DIGEST_A);
    const manifest = manifestOf("production", "release", beta);
    await imageStep(makeCtx(state, "production", "image"), stateOf(manifest), copied(DIGEST_A));
    expect(manifest.gateway).toMatchObject({ digest: DIGEST_A, source: "copied" });
    expect(manifest.gateway.codeSha ?? null).toBeNull();
    const other = world("production", null, DIGEST_B);
    await failsWith(imageStep(makeCtx(other, "production", "image"), stateOf(manifestOf("production", "release", beta)), copied(DIGEST_A)), "REFUSED", /no Code commit for the gateway to copy.*does not run that image from Cloud/u);
    // beta kept a Cloud-built gateway, but production's stack was already switched to Code: refused (production would have no Code commit to copy)
    const switched = world("production", null, DIGEST_A, { DeployedCodeSha: CODE });
    await failsWith(imageStep(makeCtx(switched, "production", "image"), stateOf(manifestOf("production", "release", beta)), copied(DIGEST_A)), "REFUSED", /no Code commit for the gateway to copy/u);
    const none = world("production", null, null);
    await failsWith(imageStep(makeCtx(none, "production", "image"), stateOf(manifestOf("production", "release", beta)), copied(DIGEST_A)), "REFUSED", /no Code commit for the gateway to copy/u);
  });
});
