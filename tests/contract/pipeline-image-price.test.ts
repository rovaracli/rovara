import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runImage } from "../../ops/pipeline/steps/image.ts";
import { contentTagFor, imageTagFor } from "../../ops/pipeline/lib/ecr.ts";
import { gate as digestEqual } from "../../ops/pipeline/gates/gateway-digest-equal.gate.ts";
import { gate as priceFresh } from "../../ops/pipeline/gates/price-freshness.gate.ts";
import { runPhase } from "../../ops/pipeline/lib/gates.ts";
import { loadGatePolicy } from "../../ops/pipeline/config.ts";
import type { GateInput, ImageStepInput, ImageStepResult, Manifest, PipelineEnv } from "../../ops/pipeline/types.ts";
import { DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, config, fakeSwitches, makePorts, newState, sha, stackFor } from "./pipeline-stage-fakes.ts";
import { BETA_ACCOUNT, BETA_PROFILE, BETA_REPO, PASSWORD, PROD_REPO, REGION, T0, makeHarness, registryOf } from "./pipeline-image-price-fakes.ts";
import type { Call } from "./pipeline-image-price-fakes.ts";
import { FAKE_ACCOUNT } from "./pipeline-stage-fakes.ts";

const h = makeHarness();
afterAll(() => { h.restorePath(); });

/** Beta names its image by the build-context hash (the fake `model-gateway-image.ts context` reports "a" x 64); `LEGACY_TAG` is the older per-execution form, still readable. */
const TAG = `ctx-${"a".repeat(64)}`;
const LEGACY_TAG = `pipe-${EXEC8}-${sha("4").slice(0, 9)}`;
const BETA_REG = registryOf(FAKE_ACCOUNT);
const betaUri = `${BETA_REG}/${BETA_REPO}`;
const prodRegistry = registryOf(FAKE_ACCOUNT);
void BETA_ACCOUNT;

const manifest = (gateway: Partial<Manifest["gateway"]> = {}): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-24T12:00:00.000Z", mode: "release",
  cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: null, production: null } },
  code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null },
  gateway: { digest: null, source: null, imageTag: null, repository: null, ...gateway }, stages: {},
});

const imageInput = (env: PipelineEnv, m: Manifest, supplied: ImageStepInput["supplied"] = null, logs: string[] = []): ImageStepInput => ({
  env, manifest: m, supplied, dirs: { pipeline: "/pipeline", cloud: `${h.dir}/cloud`, out: `${h.dir}/out`, work: `${h.dir}/work` }, ports: h.ports(env), log: (line) => { logs.push(line); },
});

/** Beta's world: its images stack (in the beta account of the run) and nothing pushed yet. In the beta environment the run's own account is the profile's. */
function betaWorld(): void {
  h.scenario.accounts = { "": FAKE_ACCOUNT, [BETA_PROFILE]: FAKE_ACCOUNT };
  h.scenario.stacks["rovara-cloud-beta-gateway-images"] = { outputs: { RepositoryUri: betaUri } };
}
/** Production's world: its own images stack in the default account, beta's repository in the beta profile's account. */
function prodWorld(digest = DIGEST_A): { srcRegistry: string; prodUri: string } {
  h.scenario.accounts = { "": FAKE_ACCOUNT, [BETA_PROFILE]: BETA_ACCOUNT };
  const prodUri = `${prodRegistry}/${PROD_REPO}`;
  h.scenario.stacks["rovara-cloud-production-gateway-images"] = { outputs: { RepositoryUri: prodUri } };
  h.scenario.ecr[BETA_REPO] = { [TAG]: digest };
  return { srcRegistry: registryOf(BETA_ACCOUNT), prodUri };
}

beforeEach(() => {
  h.scenario = { ...h.scenario, stacks: {}, resources: [], ecr: {}, ecrDigests: {}, pushFails: false, contextSha256: "a".repeat(64), contextExit: 0, contextNoise: false, buildHash: "same" as const, head: sha("4"), dirty: "", ignored: "", pushReportsDigest: null, buildExit: 0, platform: "linux/arm64", craneCopyExit: 0, craneCopyDigest: null, craneDigestOverride: null, logEvents: [], eventsAfterRunTask: [], targets: null, runTask: null, describeTasks: [] };
  h.write();
  h.reset();
});

/** Production runs with BETA_ACCOUNT_ID set like the L1b project sets it. */
const prodEnv = { BETA_ACCOUNT_ID: BETA_ACCOUNT };
const refused = async (promise: Promise<unknown>, exitName: string, text: RegExp): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ exitName });
  await expect(promise).rejects.toThrow(text);
};
const aws = (calls: Call[]): string[] => calls.filter((c) => c.tool === "aws").map((c) => c.args.slice(0, 2).join(" "));

describe("L6 image step, beta: build once, push under the immutable tag", () => {
  it("builds linux/arm64 in the candidate tree, pushes with a throwaway login, and returns the digest the tag resolves to", async () => {
    betaWorld();
    h.scenario.pushDigest = DIGEST_A;
    h.write();
    const logs: string[] = [];
    const result = await runImage(imageInput("beta", manifest(), null, logs));
    expect(result).toEqual<ImageStepResult>({ digest: DIGEST_A, source: "built", imageTag: TAG, repository: BETA_REPO });
    const lines = h.lines();
    const config8 = `${h.dir}/work/registry-auth-docker`;
    expect(lines.filter((l) => !l.startsWith("aws sts") && !l.startsWith("aws cloudformation"))).toEqual([
      "git rev-parse HEAD",
      "git status --porcelain --untracked-files=all -- packages/model-gateway environments/model-gateway tsconfig.base.json scripts/model-gateway-image.ts",
      "git status --porcelain --ignored --untracked-files=all -- packages/model-gateway/src",
      `npx --no-install tsx scripts/model-gateway-image.ts context --out ${h.dir}/work/gateway-context`,
      `aws ecr describe-images --repository-name ${BETA_REPO} --image-ids imageTag=${TAG}`,
      `npx --no-install tsx scripts/model-gateway-image.ts build --tag rovara-model-gateway:${TAG}`,
      "docker image inspect rovara-model-gateway:" + TAG + " --format {{.Os}}/{{.Architecture}}",
      "aws ecr get-authorization-token",
      `docker login --username AWS --password-stdin ${BETA_REG}`,
      `docker tag rovara-model-gateway:${TAG} ${betaUri}:${TAG}`,
      `docker push ${betaUri}:${TAG}`,
      `aws ecr describe-images --repository-name ${BETA_REPO} --image-ids imageTag=${TAG}`,
    ]);
    const calls = h.calls();
    expect(calls.filter((c) => c.tool === "npx").map((c) => c.cwd)).toEqual([`${h.dir}/cloud`, `${h.dir}/cloud`]);
    const login = calls.find((c) => c.tool === "docker" && c.args[0] === "login")!;
    expect(login.stdin).toBe(PASSWORD);
    expect(login.dockerConfig).toBe(config8);
    expect(calls.find((c) => c.tool === "docker" && c.args[0] === "push")!.dockerConfig).toBe(config8);
    // the password is on stdin only: in no argument and in no log line
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(PASSWORD);
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  it("an existing tag for the same build context is reused: nothing is rebuilt or pushed", async () => {
    betaWorld();
    h.scenario.ecr[BETA_REPO] = { [TAG]: DIGEST_B };
    h.write();
    const result = await runImage(imageInput("beta", manifest()));
    expect(result).toMatchObject({ digest: DIGEST_B, source: "built", imageTag: TAG });
    expect(h.calls().some((c) => c.tool === "docker")).toBe(false);
    expect(h.calls().filter((c) => c.tool === "npx").map((c) => c.args)).toEqual([["--no-install", "tsx", "scripts/model-gateway-image.ts", "context", "--out", `${h.dir}/work/gateway-context`]]);
  });

  it("the same context in ANOTHER execution and Cloud commit finds the same tag: no build, no push, the same digest (a Code-only run leaves the gateway alone)", async () => {
    betaWorld();
    h.scenario.pushDigest = DIGEST_A;
    h.write();
    const first = await runImage(imageInput("beta", manifest()));
    expect(first).toEqual<ImageStepResult>({ digest: DIGEST_A, source: "built", imageTag: TAG, repository: BETA_REPO });
    expect(h.calls().some((c) => c.tool === "docker" && c.args[0] === "push")).toBe(true);
    h.reset();
    h.scenario.ecr[BETA_REPO] = { [TAG]: DIGEST_A }; // what the first run pushed (the fake keeps it in its own file; rewriting the scenario must carry it over)
    h.scenario.head = sha("9"); // the second execution's candidate tree is at its own (newer) Cloud commit
    h.write();
    // another execution (new exec8, new Cloud sha, a manifest still holding the first run's tag or none): only the context hash matters
    const later: Manifest = { ...manifest({ imageTag: LEGACY_TAG, digest: DIGEST_B }), exec8: "ffffeeee", executionId: "ffffeeee-1111-2222-3333-4444555566ab", cloud: { ...manifest().cloud, sha: sha("9") } };
    const logs: string[] = [];
    const second = await runImage(imageInput("beta", later, null, logs));
    expect(second).toEqual<ImageStepResult>({ digest: DIGEST_A, source: "built", imageTag: TAG, repository: BETA_REPO });
    expect(h.calls().some((c) => c.tool === "docker" || c.tool === "crane")).toBe(false);
    expect(h.calls().filter((c) => c.tool === "npx").every((c) => c.args.includes("context"))).toBe(true);
    expect(h.calls().filter((c) => c.tool === "aws").map((c) => c.args.slice(0, 2).join(" ")).filter((l) => l.startsWith("ecr") && l !== "ecr describe-images")).toEqual([]);
    expect(logs.join("\n")).toMatch(/already in .* \(same gateway build context, pushed 2026-11-20T12:00:00\+00:00\): reusing .*no build, no push/);
  });

  it("a changed build context is a new tag: it builds, tags and pushes under the new content tag and leaves the old image alone", async () => {
    betaWorld();
    h.scenario.ecr[BETA_REPO] = { [TAG]: DIGEST_B };
    h.scenario.contextSha256 = `b${"a".repeat(63)}`;
    h.scenario.pushDigest = DIGEST_A;
    h.write();
    const NEW_TAG = `ctx-b${"a".repeat(63)}`;
    const result = await runImage(imageInput("beta", manifest()));
    expect(result).toEqual<ImageStepResult>({ digest: DIGEST_A, source: "built", imageTag: NEW_TAG, repository: BETA_REPO });
    expect(h.lines()).toContain(`docker push ${betaUri}:${NEW_TAG}`);
    expect(h.lines().filter((l) => l.startsWith("docker push"))).toHaveLength(1);
  });

  const workDir = (): string => `${h.dir}/work/gateway-context`;
  const noBuildOrPush = (): void => {
    expect(h.calls().some((c) => c.tool === "docker" || c.tool === "crane")).toBe(false);
    expect(h.calls().some((c) => c.tool === "npx" && c.args.includes("build"))).toBe(false);
  };

  it("a context script that exits non-zero after printing a valid-looking hash is a failure: nothing is built or pushed, and its directory is gone", async () => {
    betaWorld();
    h.scenario.contextExit = 1;
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /context could not be computed \(exit 1\)/);
    noBuildOrPush();
    expect(existsSync(workDir())).toBe(false);
  });

  it("the hash is the LAST stdout line: a banner or noise line printed first (even JSON without a hash) is ignored", async () => {
    betaWorld();
    h.scenario.contextNoise = true;
    h.scenario.pushDigest = DIGEST_A;
    h.write();
    expect(await runImage(imageInput("beta", manifest()))).toMatchObject({ digest: DIGEST_A, imageTag: TAG });
  });

  it("a context directory left by a crashed earlier attempt does not break the retry, and nothing is left behind after success", async () => {
    betaWorld();
    mkdirSync(workDir(), { recursive: true });
    writeFileSync(`${workDir()}/stale-file`, "left over");
    h.scenario.pushDigest = DIGEST_A;
    h.write();
    expect(await runImage(imageInput("beta", manifest()))).toMatchObject({ digest: DIGEST_A });
    expect(existsSync(workDir())).toBe(false);
  });

  it("an ECR answer that is not a digest on the reuse path is refused: nothing is reused, built or pushed", async () => {
    betaWorld();
    h.scenario.ecr[BETA_REPO] = { [TAG]: "not-a-digest" };
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /resolves to something that is not a digest/);
    noBuildOrPush();
  });

  it("the context the build used must be the one the tag was made from: another hash, or no hash, is refused before any push", async () => {
    betaWorld();
    h.scenario.buildHash = "other";
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /build used context bbbbbbbbbbbb\.\.\., not aaaaaaaaaaaa\.\.\. the tag was made from/);
    h.scenario.buildHash = "none";
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /printed no context hash/);
    expect(h.calls().some((c) => c.tool === "docker" && (c.args[0] === "push" || c.args[0] === "tag"))).toBe(false);
  });

  it("the hash is only taken from a clean checkout of the manifest's Cloud commit: another HEAD or an edited/untracked gateway file is refused before the context is computed", async () => {
    betaWorld();
    h.scenario.head = sha("9");
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /not at the manifest's Cloud commit/);
    h.scenario.head = sha("4");
    h.scenario.dirty = " M packages/model-gateway/src/main.ts\n?? packages/model-gateway/src/extra.ts\n";
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /changed or untracked files under the gateway's build inputs/);
    h.scenario.dirty = " M scripts/model-gateway-image.ts\n"; // the script decides how the image is built and prints the hash: it is a build input too
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /changed or untracked files under the gateway's build inputs/);
    h.scenario.dirty = "";
    h.scenario.ignored = "!! packages/model-gateway/src/dist/extra.ts\n"; // an ignored file in a reused tree would enter the context unseen by a plain status
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /ignored files under the gateway source/);
    expect(h.calls().some((c) => c.tool === "npx" || c.tool === "docker")).toBe(false);
  });

  it("refuses when the context script fails or prints no usable hash: nothing is built or pushed", async () => {
    betaWorld();
    h.scenario.contextSha256 = "not-a-hash";
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /context hash is not 64 hex/);
    expect(h.calls().some((c) => c.tool === "docker")).toBe(false);
    expect(h.calls().some((c) => c.tool === "npx" && c.args.includes("build"))).toBe(false);
  });

  it("refuses a build that fails, an image that is not linux/arm64 (never pushed), and a missing or foreign repository", async () => {
    betaWorld();
    h.scenario.buildExit = 3;
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /build exited 3/);
    h.scenario.buildExit = 0;
    h.scenario.platform = "linux/amd64";
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /linux\/amd64, not linux\/arm64/);
    expect(h.calls().some((c) => c.tool === "docker" && c.args[0] === "push")).toBe(false);
    h.scenario.stacks = {};
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /rovara-cloud-beta-gateway-images does not exist/);
    h.scenario.stacks["rovara-cloud-beta-gateway-images"] = { outputs: { RepositoryUri: `${registryOf(BETA_ACCOUNT)}/${BETA_REPO}` } };
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /not in the account this run uses/);
    h.scenario.stacks["rovara-cloud-beta-gateway-images"] = { outputs: { RepositoryUri: "not-a-repository" } };
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /not an ECR repository address/);
  });

  it("an immutable-tag collision during the push is refused, and a push that reports another digest than the tag resolves to is refused", async () => {
    betaWorld();
    h.scenario.pushFails = true;
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "FAILED", /docker push failed/);
    // the tag shows up in the repository (someone else pushed it) while the push is refused
    h.scenario.pushFails = true;
    h.scenario.ecr[BETA_REPO] = {};
    h.write();
    const racing = imageInput("beta", manifest());
    const aws0 = racing.ports.aws;
    const real = aws0.json.bind(aws0);
    let described = 0;
    aws0.json = async (args, opts) => {
      if (args[0] === "ecr" && args[1] === "describe-images" && (described += 1) === 2) { h.scenario.ecr[BETA_REPO] = { [TAG]: DIGEST_B }; h.write(); }
      return real(args, opts);
    };
    await refused(runImage(racing), "REFUSED", /appeared in .* while this step was building/);
    h.scenario.pushFails = false;
    h.scenario.ecr[BETA_REPO] = {};
    h.scenario.pushDigest = DIGEST_A;
    h.scenario.pushReportsDigest = DIGEST_B;
    h.write();
    await refused(runImage(imageInput("beta", manifest())), "REFUSED", /push reported .* resolves to/);
  });

  it("a supplied digest must already be in this environment's repository: nothing is built, pushed or copied", async () => {
    betaWorld();
    h.scenario.ecr[BETA_REPO] = { "older-tag": DIGEST_B };
    h.write();
    expect(await runImage(imageInput("beta", manifest(), { digest: DIGEST_B }))).toEqual({ digest: DIGEST_B, source: "supplied", imageTag: "older-tag", repository: BETA_REPO });
    await refused(runImage(imageInput("beta", manifest(), { digest: DIGEST_A })), "REFUSED", /supplied digest is not in the repository/);
    expect(h.calls().some((c) => ["npx", "docker", "crane"].includes(c.tool))).toBe(false);
  });
});

describe("L6 image step, production: crane copy beta's digest, never a rebuild", () => {
  const betaStage = (account: string | null): Manifest["stages"] => ({ beta: { env: "beta", startedAt: "x", skipped: null, account, dryRun: null, completed: ["preflight", "image"], gates: [], changeSets: [], rollback: null, releaseCheck: null, summary: null, warnings: [] } });
  const prodManifest = (over: Partial<Manifest["gateway"]> = {}, account: string | null = BETA_ACCOUNT): Manifest => ({ ...manifest({ digest: DIGEST_A, source: "built", imageTag: TAG, repository: BETA_REPO, ...over }), stages: betaStage(account) });

  it("copies beta@digest to the production tag with the exact crane commands, and asserts the digest is equal", async () => {
    const { srcRegistry, prodUri } = prodWorld();
    h.write();
    const logs: string[] = [];
    const result = await runImage(imageInput("production", prodManifest(), null, logs), { env: prodEnv });
    expect(result).toEqual<ImageStepResult>({ digest: DIGEST_A, source: "copied", imageTag: TAG, repository: PROD_REPO });
    const calls = h.calls();
    const interesting = calls.filter((c) => c.tool !== "aws" || !/^(sts assume-role|cloudformation)/u.test(c.args.slice(0, 2).join(" ")));
    expect(interesting.map((c) => `${c.profile || "-"} ${c.tool} ${c.args.join(" ").replace(/ --region [^ ]+ --output json$/u, "")}`)).toEqual([
      `- aws sts get-caller-identity`,
      `- aws ecr describe-images --repository-name ${BETA_REPO} --image-ids imageDigest=${DIGEST_A} --registry-id ${BETA_ACCOUNT}`,
      `- aws ecr describe-images --repository-name ${PROD_REPO} --image-ids imageTag=${TAG}`,
      `- aws ecr get-authorization-token`,
      `- crane auth login ${srcRegistry} --username AWS --password-stdin`,
      `- crane auth login ${prodRegistry} --username AWS --password-stdin`,
      `- crane copy ${srcRegistry}/${BETA_REPO}@${DIGEST_A} ${prodUri}:${TAG}`,
      `- crane digest ${prodUri}:${TAG}`,
      `- aws ecr describe-images --repository-name ${PROD_REPO} --image-ids imageTag=${TAG}`,
    ]);
    // production reads beta with its OWN credentials: no profile and no assumed role anywhere
    expect(calls.every((c) => c.profile === "")).toBe(true);
    // both logins write into ONE throwaway config, password on stdin only
    const logins = calls.filter((c) => c.tool === "crane" && c.args[0] === "auth");
    expect(logins.map((c) => c.dockerConfig)).toEqual([`${h.dir}/work/registry-auth-crane`, `${h.dir}/work/registry-auth-crane`]);
    expect(logins.every((c) => c.stdin === PASSWORD)).toBe(true);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(PASSWORD);
    expect(logs.join("\n")).not.toContain(PASSWORD);
    // never a build
    expect(calls.some((c) => c.tool === "npx" || (c.tool === "docker"))).toBe(false);
    expect(aws(calls).length).toBeGreaterThan(0);
  });

  it("is idempotent: the tag already holding the same digest is success and copies nothing", async () => {
    prodWorld();
    h.scenario.ecr[PROD_REPO] = { [TAG]: DIGEST_A };
    h.write();
    expect(await runImage(imageInput("production", prodManifest()), { env: prodEnv })).toMatchObject({ digest: DIGEST_A, source: "copied", imageTag: TAG, repository: PROD_REPO });
    expect(h.calls().some((c) => c.tool === "crane")).toBe(false);
  });

  it("refuses an existing tag that holds a different digest (the repository is immutable), without copying", async () => {
    prodWorld();
    h.scenario.ecr[PROD_REPO] = { [TAG]: DIGEST_B };
    h.write();
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv }), "REFUSED", /already exists in .* with .* not beta's/);
    expect(h.calls().some((c) => c.tool === "crane")).toBe(false);
  });

  it("refuses when the digest read back is not beta's, from crane or from ECR (do not deploy it)", async () => {
    prodWorld();
    h.scenario.craneDigestOverride = DIGEST_B;
    h.write();
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv }), "REFUSED", /after the copy .* not beta's/);
    h.scenario.ecr[PROD_REPO] = {};
    h.scenario.craneDigestOverride = null;
    h.scenario.craneCopyDigest = DIGEST_B;
    h.write();
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv }), "REFUSED", /not beta's/);
  });

  it("refuses a digest beta does not hold, a failed copy, and a missing crane", async () => {
    const { prodUri } = prodWorld();
    void prodUri;
    h.scenario.ecr[BETA_REPO] = {};
    h.write();
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv }), "REFUSED", /does not hold sha256:a+.* nothing to copy/);
    h.scenario.ecr[BETA_REPO] = { [TAG]: DIGEST_A };
    h.scenario.craneCopyExit = 1;
    h.write();
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv }), "FAILED", /crane copy failed/);
    h.scenario.craneCopyExit = 127;
    h.write();
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv }), "FAILED", /crane is not installed/);
  });

  it("refuses unsafe inputs: no digest, a repository that is not beta's, no recorded beta account, BETA_ACCOUNT_ID absent, malformed or different from the recorded one, or equal to production's", async () => {
    prodWorld();
    h.write();
    await refused(runImage(imageInput("production", prodManifest({ digest: null })), { env: prodEnv }), "REFUSED", /no beta digest to copy/);
    await refused(runImage(imageInput("production", prodManifest({ repository: PROD_REPO })), { env: prodEnv }), "REFUSED", /does not name beta's gateway-images repository/);
    await refused(runImage(imageInput("production", prodManifest({ repository: null })), { env: prodEnv }), "REFUSED", /does not name beta's gateway-images repository/);
    await refused(runImage(imageInput("production", prodManifest({}, null)), { env: prodEnv }), "REFUSED", /records no beta account/);
    await refused(runImage(imageInput("production", prodManifest({}, "not-an-account")), { env: prodEnv }), "REFUSED", /records no beta account/);
    // BETA_ACCOUNT_ID: absent, malformed, different from the recorded account, or equal to production's (then recorded must agree too)
    await refused(runImage(imageInput("production", prodManifest()), { env: {} }), "REFUSED", /BETA_ACCOUNT_ID is not set to a 12-digit account/);
    await refused(runImage(imageInput("production", prodManifest()), { env: { BETA_ACCOUNT_ID: "beta" } }), "REFUSED", /BETA_ACCOUNT_ID is not set to a 12-digit account/);
    await refused(runImage(imageInput("production", prodManifest()), { env: { BETA_ACCOUNT_ID: FAKE_ACCOUNT } }), "REFUSED", /differs from the beta account this execution recorded/);
    await refused(runImage(imageInput("production", prodManifest({}, FAKE_ACCOUNT)), { env: { BETA_ACCOUNT_ID: FAKE_ACCOUNT } }), "REFUSED", /beta account is the production account/);
    expect(h.calls().some((c) => c.tool === "crane")).toBe(false);
  });

  it("refuses when beta and production are in different regions (the source is addressed in production's region)", async () => {
    prodWorld();
    h.write();
    const apart = { ...fakeSwitches, environments: { ...fakeSwitches.environments, beta: { ...fakeSwitches.environments.beta, region: "eu-west-1" } } };
    await refused(runImage(imageInput("production", prodManifest()), { env: prodEnv, switches: apart }), "REFUSED", /beta runs in eu-west-1 but the production repository is in us-east-1/);
    expect(h.calls().some((c) => c.tool === "crane")).toBe(false);
    expect(await runImage(imageInput("production", prodManifest()), { env: prodEnv, switches: fakeSwitches })).toMatchObject({ source: "copied" });
  });

  it("an older run's pipe- tag recorded in the manifest still parses: production copies under it (rollback records and in-flight executions keep working)", async () => {
    prodWorld();
    h.scenario.ecr[BETA_REPO] = { [LEGACY_TAG]: DIGEST_A };
    h.write();
    expect(await runImage(imageInput("production", prodManifest({ imageTag: LEGACY_TAG })), { env: prodEnv })).toEqual<ImageStepResult>({ digest: DIGEST_A, source: "copied", imageTag: LEGACY_TAG, repository: PROD_REPO });
    expect(h.lines().some((l) => l.startsWith(`crane copy ${registryOf(BETA_ACCOUNT)}/${BETA_REPO}@${DIGEST_A} ${prodRegistry}/${PROD_REPO}:${LEGACY_TAG}`))).toBe(true);
  });

  it("production copies a ctx- tag beta recorded; a recorded value that is neither form is ignored for the older per-execution tag", async () => {
    prodWorld();
    h.write();
    expect((await runImage(imageInput("production", prodManifest({ imageTag: TAG })), { env: prodEnv })).imageTag).toBe(TAG);
    for (const bad of ["ctx-ABCDEF0123456789".padEnd(68, "A"), "ctx-abc", "latest", "pipe-1234-5678", `ctx-${"a".repeat(16)}`, `ctx-${"a".repeat(65)}`, `ctx-${"a".repeat(63)}g`]) {
      expect(imageTagFor(manifest({ imageTag: bad }))).toBe(LEGACY_TAG);
    }
    for (const good of [TAG, LEGACY_TAG, `ctx-${"0123456789abcdef".repeat(4)}`, "pipe-deadbeef-012345678"]) expect(imageTagFor(manifest({ imageTag: good }))).toBe(good);
    expect(contentTagFor("f".repeat(64))).toBe(`ctx-${"f".repeat(64)}`);
    expect(contentTagFor("f".repeat(64))).toHaveLength(68);
    expect(() => contentTagFor("f".repeat(63))).toThrow(/64 hex/);
  });

  it("recomputes the tag when the manifest holds none, and a supplied digest is checked against the production repository only", async () => {
    prodWorld();
    h.write();
    expect((await runImage(imageInput("production", prodManifest({ imageTag: null })), { env: prodEnv })).imageTag).toBe(LEGACY_TAG);
    h.scenario.ecr[PROD_REPO] = { old: DIGEST_B };
    h.write();
    expect(await runImage(imageInput("production", prodManifest(), { digest: DIGEST_B }), { env: prodEnv })).toMatchObject({ source: "supplied", repository: PROD_REPO });
  });
});

// ---- the gates ----

const gateInput = (env: PipelineEnv, m: Manifest, ports: GateInput["ports"], logs: string[] = []): GateInput => ({
  env, phase: "proof", region: REGION, config, manifest: m, changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports, log: (line) => { logs.push(line); },
});

describe("L6 gate gateway-digest-equal", () => {
  const withLive = (parameters: Record<string, string> | null, status = "UPDATE_COMPLETE"): GateInput["ports"] => {
    const state = newState();
    if (parameters !== null) state.stacks[stackFor("production", "gateway")] = { status, parameters, outputs: {}, templateSha: "t" };
    return makePorts(state, "production");
  };

  it("passes when the live ImageDigest parameter is the manifest digest", async () => {
    const outcome = await digestEqual.run(gateInput("production", manifest({ digest: DIGEST_A }), withLive({ ImageDigest: DIGEST_A })));
    expect(outcome).toMatchObject({ result: "pass", data: { digest: DIGEST_A } });
  });

  it("a dry run reports skipped with a clear reason, never a pass, even with a matching digest", async () => {
    const outcome = await digestEqual.run({ ...gateInput("production", manifest({ digest: DIGEST_A }), withLive({ ImageDigest: DIGEST_A })), dryRun: true });
    expect(outcome).toEqual({ result: "skipped", skippedReason: "dry run: no image built" });
    expect(await digestEqual.run({ ...gateInput("production", manifest(), withLive(null)), dryRun: true })).toMatchObject({ result: "skipped" });
  });

  it("fails on another digest, a missing parameter, an absent stack, and a manifest without a digest", async () => {
    expect(await digestEqual.run(gateInput("production", manifest({ digest: DIGEST_A }), withLive({ ImageDigest: DIGEST_B })))).toMatchObject({ result: "fail", failures: [expect.stringMatching(/runs sha256:b+ but this execution's gateway digest is sha256:a+/)] });
    expect(await digestEqual.run(gateInput("production", manifest({ digest: DIGEST_A }), withLive({})))).toMatchObject({ result: "fail", failures: [expect.stringMatching(/no ImageDigest parameter/)] });
    expect(await digestEqual.run(gateInput("production", manifest({ digest: DIGEST_A }), withLive(null)))).toMatchObject({ result: "fail", failures: [expect.stringMatching(/does not exist/)] });
    expect(await digestEqual.run(gateInput("production", manifest(), withLive({ ImageDigest: DIGEST_A })))).toMatchObject({ result: "fail", failures: [expect.stringMatching(/no gateway digest/)] });
  });
});

describe("L6 gate price-freshness", () => {
  const ARN = `arn:aws:ecs:${REGION}:${FAKE_ACCOUNT}:cluster/Cluster1`;
  const world = (): void => {
    h.scenario.stacks[stackFor("beta", "gateway")] = { parameters: { ImageDigest: DIGEST_A } };
    h.scenario.resources = [
      { LogicalResourceId: "Cluster1ABC", ResourceType: "AWS::ECS::Cluster", PhysicalResourceId: "Cluster1" },
      { LogicalResourceId: "ServeTask1", ResourceType: "AWS::ECS::TaskDefinition", PhysicalResourceId: `arn:aws:ecs:${REGION}:${FAKE_ACCOUNT}:task-definition/Serve:3` },
      { LogicalResourceId: "PriceFetchTask7EDA4B48", ResourceType: "AWS::ECS::TaskDefinition", PhysicalResourceId: `arn:aws:ecs:${REGION}:${FAKE_ACCOUNT}:task-definition/PriceFetch:2` },
      { LogicalResourceId: "PriceFetchTaskRole1", ResourceType: "AWS::IAM::Role", PhysicalResourceId: "role" },
      { LogicalResourceId: "PriceFetchScheduleXYZ", ResourceType: "AWS::Events::Rule", PhysicalResourceId: "the-rule" },
      { LogicalResourceId: "PriceFetchLogsQ", ResourceType: "AWS::Logs::LogGroup", PhysicalResourceId: "the-log-group" },
    ];
    h.scenario.targets = { Targets: [{ Arn: ARN, EcsParameters: { LaunchType: "FARGATE", NetworkConfiguration: { awsvpcConfiguration: { Subnets: ["subnet-a", "subnet-b"], SecurityGroups: ["sg-1"], AssignPublicIp: "ENABLED" } } } }] };
    h.scenario.runTask = { tasks: [{ taskArn: `${ARN.replace("cluster", "task")}/abc` }], failures: [] };
    h.scenario.describeTasks = [{ tasks: [{ lastStatus: "RUNNING" }] }, { tasks: [{ lastStatus: "STOPPED", containers: [{ exitCode: 0 }] }] }];
    h.write();
  };
  const run = (): Promise<Awaited<ReturnType<typeof priceFresh.run>>> => priceFresh.run(gateInput("beta", manifest({ digest: DIGEST_A }), h.ports("beta")));

  it("passes on a successful fetch inside 48 hours without running anything, reading the log group the stack names", async () => {
    world();
    h.scenario.logEvents = [T0 - 30 * 3_600_000, T0 - 5 * 3_600_000];
    h.write();
    expect(await run()).toMatchObject({ result: "pass", data: { ageHours: 5 } });
    const lines = h.lines();
    expect(lines).toContain(`aws cloudformation list-stack-resources --stack-name rovara-cloud-beta-gateway`);
    expect(lines).toContain(`aws logs filter-log-events --log-group-name the-log-group --filter-pattern { $.event = "price_fetched" } --start-time ${T0 - 48 * 3_600_000}`);
    expect(lines.some((l) => l.startsWith("aws ecs"))).toBe(false);
    // the stack resources are read as the CDK deploy role (its session credentials, no profile); the log read uses the release profile
    const calls = h.calls();
    expect(calls.find((c) => c.args[1] === "list-stack-resources")).toMatchObject({ key: "AKIAFAKE", profile: "" });
    expect(calls.find((c) => c.args[1] === "filter-log-events")).toMatchObject({ key: "", profile: BETA_PROFILE });
  });

  it("stale: runs the price-fetch task once with the schedule's settings (no overrides, no tags), waits for exit 0, and passes when the fetch is logged", async () => {
    world();
    h.scenario.logEvents = [T0 - 60 * 3_600_000];
    h.scenario.eventsAfterRunTask = [T0 + 90_000];
    h.write();
    expect(await run()).toMatchObject({ result: "pass", notes: [expect.stringMatching(/refreshed/)], data: { refreshed: true } });
    const lines = h.lines();
    expect(lines).toContain(`aws events list-targets-by-rule --rule the-rule`);
    const network = JSON.stringify({ awsvpcConfiguration: { subnets: ["subnet-a", "subnet-b"], securityGroups: ["sg-1"], assignPublicIp: "ENABLED" } });
    expect(lines).toContain(`aws ecs run-task --cluster ${ARN} --task-definition arn:aws:ecs:${REGION}:${FAKE_ACCOUNT}:task-definition/PriceFetch:2 --launch-type FARGATE --count 1 --client-token rovara-price-${EXEC8}-proof-${T0} --network-configuration ${network}`);
    const runTask = lines.find((l) => l.startsWith("aws ecs run-task"))!;
    expect(runTask).not.toMatch(/--overrides|--tags|--propagate-tags|--enable-execute-command/u);
    expect(lines.filter((l) => l.startsWith("aws ecs describe-tasks"))).toHaveLength(2);
  });

  it("stale and the task fails: refuses with a clear message naming the age limit, the exit code and what to do", async () => {
    world();
    h.scenario.describeTasks = [{ tasks: [{ lastStatus: "STOPPED", containers: [{ exitCode: 1, reason: "Essential container exited" }] }] }];
    h.write();
    const outcome = await run();
    expect(outcome.result).toBe("fail");
    expect(outcome.failures![0]).toMatch(/prices are stale: no successful price fetch in the last 48 h, and the one-off price fetch did not succeed: .*exit code 1.*re-run the proof/u);
  });

  it("stale and ECS refuses to start the task, or the schedule targets another cluster, or the task exits 0 without a logged fetch: refuses", async () => {
    world();
    h.scenario.runTask = { tasks: [], failures: [{ reason: "RESOURCE:FARGATE" }] };
    h.write();
    expect((await run()).failures![0]).toMatch(/ECS did not start the price-fetch task: RESOURCE:FARGATE/);
    world();
    h.reset();
    h.scenario.targets = { Targets: [{ Arn: `arn:aws:ecs:${REGION}:${FAKE_ACCOUNT}:cluster/Other`, EcsParameters: { NetworkConfiguration: { awsvpcConfiguration: { Subnets: ["s"] } } } }] };
    h.write();
    expect((await run()).failures![0]).toMatch(/different cluster/);
    expect(h.lines().some((l) => l.startsWith("aws ecs run-task"))).toBe(false);
    world();
    h.write();
    const silent = await run();
    expect(silent.result).toBe("fail");
    expect(silent.failures![0]).toMatch(/exited 0 but no price_fetched event/);
  });

  it("finds the price-fetch resources among more than 100 stack resources (list-stack-resources, not the 100-capped describe)", async () => {
    world();
    const filler = Array.from({ length: 150 }, (_, i) => ({ LogicalResourceId: `Filler${i}`, ResourceType: "AWS::SSM::Parameter", PhysicalResourceId: `p${i}` }));
    h.scenario.resources = [...filler, ...h.scenario.resources];
    h.scenario.logEvents = [T0 - 3_600_000];
    h.write();
    expect((await run()).result).toBe("pass");
    expect(h.lines().some((l) => l.includes("describe-stack-resources"))).toBe(false);
  });

  it("the run-task call carries a client token (execution + step + start time, within ECS's 64 characters) so a CLI retry cannot start a second task", async () => {
    world();
    h.scenario.eventsAfterRunTask = [T0 + 90_000];
    h.write();
    await run();
    const token = h.calls().find((c) => c.args[1] === "run-task")!.args;
    const value = token[token.indexOf("--client-token") + 1]!;
    expect(value).toBe(`rovara-price-${EXEC8}-proof-${T0}`);
    expect(value.length).toBeLessThanOrEqual(64);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("a dry run never starts the task: stale reports a skipped status saying what a real run would do (no run-task call); fresh still passes", async () => {
    world();
    h.scenario.logEvents = [T0 - 60 * 3_600_000];
    h.write();
    const dry = await priceFresh.run({ ...gateInput("beta", manifest({ digest: DIGEST_A }), h.ports("beta")), dryRun: true });
    expect(dry.result).toBe("skipped");
    expect(dry.skippedReason).toMatch(/stale: a real run would run the price-fetch task once and refuse if the prices are still stale/);
    expect(h.lines().some((l) => l.startsWith("aws ecs"))).toBe(false);
    h.scenario.logEvents = [T0 - 1 * 3_600_000];
    h.write();
    expect((await priceFresh.run({ ...gateInput("beta", manifest({ digest: DIGEST_A }), h.ports("beta")), dryRun: true })).result).toBe("pass");
  });

  it("the phase runner hands dryRun to the gate (and a real run gets none), so the stage CLI's --dry-run reaches it", async () => {
    const seen: Array<boolean | undefined> = [];
    const probe = { name: "probe", phases: ["proof"] as const, run: (i: GateInput) => { seen.push(i.dryRun); return Promise.resolve({ result: "pass" as const }); } };
    const args = { env: "beta" as const, phase: "proof" as const, region: REGION, config, gates: [probe], required: [], manifest: manifest(), changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports: makePorts(newState()), log: () => {} };
    await runPhase({ ...args, dryRun: true });
    await runPhase(args);
    expect(seen).toEqual([true, undefined]);
  });

  it("is a proof gate for both environments, required by gate-policy.json, and a throwing lookup becomes a failure of the phase", async () => {
    expect(priceFresh.phases).toEqual(["proof"]);
    expect(digestEqual.phases).toEqual(["proof"]);
    expect(loadGatePolicy().required.proof).toEqual(expect.arrayContaining(["gateway-digest-equal", "price-freshness"]));
    world();
    h.scenario.resources = h.scenario.resources.filter((r) => r.ResourceType !== "AWS::Logs::LogGroup");
    h.write();
    const result = await runPhase({ env: "beta", phase: "proof", region: REGION, config, gates: [priceFresh], required: ["price-freshness"], manifest: manifest({ digest: DIGEST_A }), changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports: { ...h.ports("beta"), fs: makePorts(newState()).fs }, log: () => {} });
    expect(result.failed).toBe(true);
    expect(result.records[0]!.failures[0]).toMatch(/expected exactly one price-fetch log group/);
  });
});
