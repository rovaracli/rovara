import { describe, expect, it } from "vitest";
import { FIND_RELEASE_TAG, CLOUD_PIPELINE_BRANCH, CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER, RELEASE_CHECK_PATHS, C1_BACKFILL_MARKER } from "../../infra/lib/cloud-release-pipeline.js";
import { cloudAppStackName } from "../../infra/lib/cloud-app.js";
import { cloudWebStackName } from "../../infra/lib/cloud-web.js";
import { modelGatewayImagesStackName, modelGatewayStackName } from "../../infra/lib/model-gateway.js";
import { changeSetNameFor, lastGoodParameter, parseConfig, parseGatePolicy, releaseTagRegex, ssmChecksPrefixFor, ssmPrefixFor, stackName } from "../../ops/pipeline/config.ts";
import { compareTags, decideMode, readLiveCloudSha, resolveCloudRef, tagOfSha } from "../../ops/pipeline/lib/refs.ts";
import { config, liveStack, makePorts, newState, sha, stackFor } from "./pipeline-stage-fakes.ts";
import { readFileSync, readdirSync } from "node:fs";

describe("pipeline stage CLI: layout config", () => {
  it("keeps the release tag rule, trunk, qualifier and release check equal to the old Cloud pipeline's", () => {
    expect(FIND_RELEASE_TAG.join("\n")).toContain(config.releaseTagPattern);
    expect(config.trunkBranches).toContain(CLOUD_PIPELINE_BRANCH);
    expect(config.bootstrapQualifier).toBe(CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER);
    expect(config.releaseCheck.paths).toEqual([...RELEASE_CHECK_PATHS]);
    expect(C1_BACKFILL_MARKER).toBe(`${ssmChecksPrefixFor(config, "$ROVARA_ENV" as "beta")}/agent-own-key-backfill`);
  });

  it("derives the stack names the infra uses, for both environments", () => {
    for (const env of ["beta", "production"] as const) {
      expect(stackName(config, env, "gateway")).toBe(modelGatewayStackName(env));
      expect(stackName(config, env, "gatewayImages")).toBe(modelGatewayImagesStackName(env));
      expect(stackName(config, env, "web")).toBe(cloudWebStackName(env));
      expect(stackName(config, env, "app")).toBe(cloudAppStackName(env));
    }
  });

  it("names every stack id the cdk app builds, and keeps the last-good record under the prefix the beta release role may write", () => {
    const app = readFileSync("infra/lib/app.ts", "utf8");
    for (const id of Object.values(config.stackIds)) expect(app).toContain(`"${id}"`);
    expect(lastGoodParameter(config, "beta")).toBe("/rovara-cloud/beta/release/last-good");
    expect(ssmPrefixFor(config, "production")).toBe("/rovara-cloud/production/release");
    expect(changeSetNameFor("1a2b3c4d")).toBe("rovara-pipeline-1a2b3c4d");
  });

  it("refuses a malformed config or gate policy", () => {
    const good = JSON.parse(readFileSync("ops/pipeline/config.json", "utf8")) as Record<string, unknown>;
    expect(() => parseConfig(JSON.stringify({ ...good, schema: 2 }))).toThrow(/schema/);
    expect(() => parseConfig(JSON.stringify({ ...good, trunkBranches: [] }))).toThrow(/trunkBranches/);
    expect(() => parseConfig(JSON.stringify({ ...good, ssmPrefix: "rovara/{env}" }))).toThrow(/ssmPrefix/);
    expect(() => parseConfig(JSON.stringify({ ...good, stackNames: { ...(good.stackNames as object), web: "fixed-name" } }))).toThrow(/stackNames.web/);
    expect(() => parseGatePolicy(JSON.stringify({ schema: 1, required: { preflight: [] } }))).toThrow(/change-sets/);
    expect(releaseTagRegex(config).test("v1.2.3")).toBe(true);
    expect(releaseTagRegex(config).test("v1.2.3-rc1")).toBe(false);
  });

  it("requires only gates that exist as files, except the ones a named lane has still to deliver", () => {
    const policy = parseGatePolicy(readFileSync("ops/pipeline/gate-policy.json", "utf8"));
    const files = new Set(readdirSync("ops/pipeline/gates").filter((name) => name.endsWith(".gate.ts")).map((name) => name.slice(0, -".gate.ts".length)));
    // Required BEFORE they exist on purpose: a run stops with exit 21 until the lane lands (fail closed). Add a name here only while its gate file is still to come.
    const notYetDelivered = new Set<string>();
    for (const names of Object.values(policy.required)) for (const name of names) expect(files.has(name) || notYetDelivered.has(name), name).toBe(true);
  });

  it("requires the protected-resource gate for change sets from the start (L3), so nothing is executed without it", () => {
    const policy = parseGatePolicy(readFileSync("ops/pipeline/gate-policy.json", "utf8"));
    expect(policy.required["change-sets"]).toEqual(expect.arrayContaining(["change-set-integrity", "protected"]));
  });
});

describe("pipeline stage CLI: ref resolution", () => {
  it("compares versions numerically, not as text", () => {
    expect(compareTags("v0.13.10", "v0.13.9")).toBeGreaterThan(0);
    expect(compareTags("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
  });

  it("takes the newest vX.Y.Z tag that is on the trunk, skipping off-trunk and prerelease tags", async () => {
    const state = newState();
    const resolved = await resolveCloudRef(makePorts(state), config, null);
    expect(resolved).toEqual({ tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next" });
    expect(state.calls).toContain("git fetchTags");
  });

  it("skips a newest tag that is not on the trunk", async () => {
    const state = newState();
    state.tags["v0.13.11"] = sha("8");
    expect((await resolveCloudRef(makePorts(state), config, null)).tag).toBe("v0.13.10");
  });

  it("uses CLOUD_REF when it is a release tag on the trunk", async () => {
    const resolved = await resolveCloudRef(makePorts(newState()), config, "v0.13.2");
    expect(resolved).toEqual({ tag: "v0.13.2", sha: sha("2"), ref: "CLOUD_REF", trunk: "cloud/next" });
  });

  it("refuses CLOUD_REF that is a branch, a prerelease, missing, or off the trunk (exit REF_FAILED)", async () => {
    const ports = makePorts(newState());
    await expect(resolveCloudRef(ports, config, "cloud/next")).rejects.toMatchObject({ exitName: "REF_FAILED" });
    await expect(resolveCloudRef(ports, config, "v0.15.0-rc1")).rejects.toMatchObject({ exitName: "REF_FAILED" });
    await expect(resolveCloudRef(ports, config, "v9.9.9")).rejects.toMatchObject({ exitName: "REF_FAILED" });
    await expect(resolveCloudRef(ports, config, "v0.14.0")).rejects.toThrow(/not on cloud\/next/);
  });

  it("refuses when no trunk branch exists or no tag is on it", async () => {
    await expect(resolveCloudRef(makePorts(newState({ branches: { "cloud/next": false } })), config, null)).rejects.toThrow(/none of the trunk branches/);
    await expect(resolveCloudRef(makePorts(newState({ tags: { "v0.14.0": sha("9") } })), config, null)).rejects.toThrow(/no vX.Y.Z release tag/);
  });

  it("tolerates a missing legacy trunk branch when another listed trunk exists (the move to mainline)", async () => {
    const moved = { ...config, trunkBranches: ["cloud/next", "mainline"] };
    const state = newState({ branches: { "cloud/next": false, mainline: true } });
    expect((await resolveCloudRef(makePorts(state), moved, null)).trunk).toBe("mainline");
  });

  it("finds the tag of a sha", async () => {
    const ports = makePorts(newState());
    expect(await tagOfSha(ports, config, sha("3"))).toBe("v0.13.9");
    expect(await tagOfSha(ports, config, sha("5"))).toBeNull();
  });
});

describe("pipeline stage CLI: live Cloud sha and mode", () => {
  const resolved = (tag: string, at: string) => ({ tag, sha: sha(at), ref: "CLOUD_REF" as const, trunk: "cloud/next" });

  it("reads DeployedCloudSha from the web stack, then the gateway, and says when it is absent", async () => {
    const state = newState();
    liveStack(state, stackFor("beta", "web"), { outputs: { DeployedCloudSha: sha("3") } });
    liveStack(state, stackFor("beta", "gateway"));
    expect(await readLiveCloudSha(makePorts(state), stackFor("beta", "web"), stackFor("beta", "gateway"))).toEqual({ sha: sha("3"), warnings: [] });
    const absent = newState();
    liveStack(absent, stackFor("beta", "web"));
    const none = await readLiveCloudSha(makePorts(absent), stackFor("beta", "web"), stackFor("beta", "gateway"));
    expect(none.sha).toBeNull();
    expect(none.warnings[0]).toMatch(/unknown/);
    const disagree = newState();
    liveStack(disagree, stackFor("beta", "web"), { outputs: { DeployedCloudSha: sha("3") } });
    liveStack(disagree, stackFor("beta", "gateway"), { outputs: { DeployedCloudSha: sha("2") } });
    expect((await readLiveCloudSha(makePorts(disagree), stackFor("beta", "web"), stackFor("beta", "gateway"))).warnings[0]).toMatch(/differs/);
  });

  it("is a release when the ref is newer than or equal to what is live", async () => {
    const ports = makePorts(newState());
    expect((await decideMode(ports, { requested: "run", resolved: resolved("v0.13.10", "4"), liveSha: sha("3"), adopt: false, env: "beta" })).mode).toBe("release");
    expect((await decideMode(ports, { requested: "run", resolved: resolved("v0.13.9", "3"), liveSha: sha("3"), adopt: false, env: "beta" })).mode).toBe("release");
  });

  it("is a rollback when the ref is a strict ancestor of what is live, and forces Code to skip", async () => {
    const ports = makePorts(newState());
    const decision = await decideMode(ports, { requested: "run", resolved: resolved("v0.13.2", "2"), liveSha: sha("4"), adopt: false, env: "beta" });
    expect(decision).toMatchObject({ mode: "rollback", codeRelease: "skip" });
  });

  it("cannot prove a rollback without the live sha: a release with a warning", async () => {
    const decision = await decideMode(makePorts(newState()), { requested: "run", resolved: resolved("v0.13.2", "2"), liveSha: null, adopt: false, env: "beta" });
    expect(decision.mode).toBe("release");
    expect(decision.warnings[0]).toMatch(/rollback cannot be told/);
  });

  it("does not guess when the live sha is not in the repository", async () => {
    const decision = await decideMode(makePorts(newState()), { requested: "run", resolved: resolved("v0.13.2", "2"), liveSha: sha("7"), adopt: false, env: "beta" });
    expect(decision.mode).toBe("release");
    expect(decision.warnings[0]).toMatch(/not in this repository/);
  });

  it("an adoption run needs CLOUD_REF and refuses a tag that is not what is live", async () => {
    const ports = makePorts(newState());
    expect((await decideMode(ports, { requested: "skip", resolved: resolved("v0.13.9", "3"), liveSha: sha("3"), adopt: true, env: "beta" })).mode).toBe("adoption");
    await expect(decideMode(ports, { requested: "run", resolved: { ...resolved("v0.13.9", "3"), ref: "latest-tag" }, liveSha: null, adopt: true, env: "beta" })).rejects.toThrow(/set CLOUD_REF/);
    await expect(decideMode(ports, { requested: "run", resolved: resolved("v0.13.2", "2"), liveSha: sha("3"), adopt: true, env: "beta" })).rejects.toThrow(/not what is live/);
    const unknown = await decideMode(ports, { requested: "run", resolved: resolved("v0.13.9", "3"), liveSha: null, adopt: true, env: "beta" });
    expect(unknown.warnings[0]).toMatch(/empty change sets are the proof/);
  });
});
