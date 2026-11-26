// Pre-review additions for #1478 phase 2 (Sonnet pre-review, GATEWAY-PHASE-2): the image step's gateway Code commit for the cases the lane's own file does not cover:
// a RELEASE run (not a rollback) that names a gateway digest (GATEWAY_DIGEST), and a PRODUCTION rollback (the Code commit comes from production's own last-good record, not from beta's manifest).
// No AWS, no network.
import { describe, expect, it } from "vitest";
import { newStageRecord } from "../../ops/pipeline/lib/manifest.ts";
import type { State } from "../../ops/pipeline/lib/run.ts";
import { imageStep } from "../../ops/pipeline/steps/image-step.ts";
import type { ImageStepInput, ImageStepResult, Manifest, PipelineEnv } from "../../ops/pipeline/types.ts";
import { DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, makeCtx, newState, sha, withCodeClone } from "./pipeline-stage-fakes.ts";

const CODE = sha("c");
const OTHER_CODE = sha("d");
const CLOUD_SHA = sha("4");

const manifestOf = (over: { env?: PipelineEnv; mode?: Manifest["mode"]; gateway?: Partial<Manifest["gateway"]> } = {}): Manifest => {
  const env = over.env ?? "beta";
  return {
    schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-25T12:00:00.000Z", mode: over.mode ?? "release",
    cloud: { tag: "v0.13.10", sha: CLOUD_SHA, ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: sha("3"), production: sha("3") } },
    code: { sha: CODE, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null },
    gateway: { digest: null, source: null, imageTag: null, repository: null, ...over.gateway },
    stages: { [env]: newStageRecord(env, new Date("2026-11-25T12:00:00.000Z"), false) },
  };
};
const stateOf = (manifest: Manifest): State => ({ manifest });
const lastGood = (env: PipelineEnv, gateway: { digest: string; codeSha?: string | null }): string => JSON.stringify({
  schema: 1, env, recordedAt: "2026-11-24T00:00:00.000Z", executionId: "earlier", mode: "release", cloud: { tag: "v0.13.9", sha: sha("3") }, gateway,
  code: { sha: CODE }, proofGates: [], previous: null,
});
const failsWith = async (promise: Promise<unknown>, exitName: string, text?: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  if (text !== undefined) await expect(promise).rejects.toThrow(text);
};
const supplied = (digest: string, seen: ImageStepInput[] = []) => (input: ImageStepInput): Promise<ImageStepResult> => {
  seen.push(input);
  return Promise.resolve({ digest, source: "supplied", imageTag: `ctx-${"a".repeat(64)}`, repository: "images" });
};

describe("a release run that names a gateway digest (GATEWAY_DIGEST): the Code commit is the one recorded with that image", () => {
  it("takes the Code commit recorded beside the digest in last-good, builds nothing and checks out no Code tree", async () => {
    const state = newState({ exec: withCodeClone() });
    state.ssm["/rovara-cloud/beta/release/last-good"] = lastGood("beta", { digest: DIGEST_A, codeSha: OTHER_CODE });
    const manifest = manifestOf();
    const seen: ImageStepInput[] = [];
    await imageStep(makeCtx(state, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifest), supplied(DIGEST_A, seen));
    expect(manifest.gateway).toMatchObject({ digest: DIGEST_A, source: "supplied", codeSha: OTHER_CODE });
    expect(seen.map((s) => ({ codeSha: s.codeSha, code: s.dirs.code }))).toEqual([{ codeSha: OTHER_CODE, code: null }]);
    expect(state.calls.some((c) => c.includes("worktree add"))).toBe(false);
  });

  it("refuses a digest the last-good record does not name, and one recorded with no Code commit (an image from before the gateway moved to Code)", async () => {
    const unnamed = newState({ exec: withCodeClone() });
    unnamed.ssm["/rovara-cloud/beta/release/last-good"] = lastGood("beta", { digest: DIGEST_A, codeSha: CODE });
    await failsWith(imageStep(makeCtx(unnamed, "beta", "image", { inputs: { gatewayDigest: DIGEST_B } }), stateOf(manifestOf()), supplied(DIGEST_B)), "REFUSED", /release run names the gateway digest.*last-good record names no such image/);
    const before = newState({ exec: withCodeClone() });
    before.ssm["/rovara-cloud/beta/release/last-good"] = lastGood("beta", { digest: DIGEST_A });
    await failsWith(imageStep(makeCtx(before, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf()), supplied(DIGEST_A)), "REFUSED", /no Code commit for it/);
    const none = newState({ exec: withCodeClone() });
    await failsWith(imageStep(makeCtx(none, "beta", "image", { inputs: { gatewayDigest: DIGEST_A } }), stateOf(manifestOf()), supplied(DIGEST_A)), "REFUSED", /release run names the gateway digest/);
  });
});

describe("a production rollback: the gateway's Code commit is the one PRODUCTION's last-good records for the digest, not the one beta's manifest carries", () => {
  it("uses production's own record", async () => {
    const state = newState({ exec: withCodeClone() });
    state.ssm["/rovara-cloud/production/release/last-good"] = lastGood("production", { digest: DIGEST_A, codeSha: CODE });
    const manifest = manifestOf({ env: "production", mode: "rollback", gateway: { digest: DIGEST_A, source: "supplied", imageTag: null, repository: "beta-images", codeSha: OTHER_CODE } });
    await imageStep(makeCtx(state, "production", "image"), stateOf(manifest), (): Promise<ImageStepResult> => Promise.resolve({ digest: DIGEST_A, source: "copied", imageTag: `ctx-${"a".repeat(64)}`, repository: "prod-images" }));
    expect(manifest.gateway.codeSha).toBe(CODE);
  });

  it("refuses when production's record names the digest with no Code commit, even though beta's manifest has one", async () => {
    const state = newState({ exec: withCodeClone() });
    state.ssm["/rovara-cloud/production/release/last-good"] = lastGood("production", { digest: DIGEST_A });
    const manifest = manifestOf({ env: "production", mode: "rollback", gateway: { digest: DIGEST_A, source: "supplied", imageTag: null, repository: "beta-images", codeSha: OTHER_CODE } });
    await failsWith(imageStep(makeCtx(state, "production", "image"), stateOf(manifest), supplied(DIGEST_A)), "ROLLBACK_REFUSED", /no Code commit for it/);
  });
});
