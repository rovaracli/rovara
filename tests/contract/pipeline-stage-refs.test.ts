import { describe, expect, it } from "vitest";
import { FIND_RELEASE_TAG, CLOUD_PIPELINE_BRANCH, CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER, RELEASE_CHECK_PATHS, C1_BACKFILL_MARKER } from "../../infra/lib/cloud-release-pipeline.js";
import { cloudAppStackName } from "../../infra/lib/cloud-app.js";
import { cloudWebStackName } from "../../infra/lib/cloud-web.js";
import { modelGatewayImagesStackName, modelGatewayStackName } from "../../infra/lib/model-gateway.js";
import { changeSetNameFor, lastGoodParameter, parseConfig, parseGatePolicy, releaseTagRegex, ssmChecksPrefixFor, ssmPrefixFor, stackName } from "../../ops/pipeline/config.ts";
import { FROM_TRIGGER, LATEST, compareTags, decideMode, readLiveCloudSha, resolveCloudRef, tagOfSha } from "../../ops/pipeline/lib/refs.ts";
import { config, liveStack, makePorts, newState, seedLastGood, sha, stackFor } from "./pipeline-stage-fakes.ts";
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

  it("CLOUD_REF=latest, empty and unset all mean the newest tag on the trunk", async () => {
    const newest = { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next" };
    expect(LATEST).toBe("latest");
    for (const requested of ["latest", "", null]) expect(await resolveCloudRef(makePorts(newState()), config, requested)).toEqual(newest);
    const state = newState();
    state.tags["v0.13.11"] = sha("8"); // off the trunk: skipped for latest too
    expect((await resolveCloudRef(makePorts(state), config, "latest")).tag).toBe("v0.13.10");
  });

  it("only the exact word latest is mapped: other words and spellings are still refused as not a release tag", async () => {
    for (const bad of ["Latest", "LATEST", "latest ", "newest", "main", "v0.13", "latest-tag"]) {
      await expect(resolveCloudRef(makePorts(newState()), config, bad), bad).rejects.toThrow(/not a release tag/u);
    }
  });

  it("an explicit vX.Y.Z is still checked: it must exist and be on the trunk", async () => {
    expect(await resolveCloudRef(makePorts(newState()), config, "v0.13.9")).toMatchObject({ tag: "v0.13.9", ref: "CLOUD_REF" });
    await expect(resolveCloudRef(makePorts(newState()), config, "v9.9.9")).rejects.toThrow(/does not exist/u);
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

describe("pipeline stage CLI: CLOUD_REF=from-trigger", () => {
  const trigger = (sourceCommit: string | null) => ({ sourceCommit, env: "beta" as const });
  const world = () => { const state = newState(); seedLastGood(state, "beta"); return state; }; // beta's last-good is v0.13.1; the newest tag on the trunk is v0.13.10

  it("exactly one release tag on the source commit is that tag (not the newest tag, not the last-good one)", async () => {
    const state = world();
    expect(await resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("3")))).toEqual({ tag: "v0.13.9", sha: sha("3"), ref: "from-trigger", trunk: "cloud/next" });
  });

  it("an explicit CLOUD_REF on a manual start still wins, and the source commit is ignored", async () => {
    const resolved = await resolveCloudRef(makePorts(world()), config, "v0.13.2", trigger(sha("3")));
    expect(resolved).toMatchObject({ tag: "v0.13.2", ref: "CLOUD_REF" });
    // and with nothing named, the newest tag as today
    expect((await resolveCloudRef(makePorts(world()), config, null, trigger(sha("3")))).tag).toBe("v0.13.10");
  });

  it("a commit on the trunk with no release tag (a Code push) keeps beta's recorded last-good Cloud, never the newest tag", async () => {
    const state = world();
    state.history.push(sha("5")); // a trunk commit nobody tagged
    expect(await resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("5")))).toEqual({ tag: "v0.13.1", sha: sha("1"), ref: "last-good", trunk: "cloud/next" });
  });

  it("a tagless commit with no last-good record is refused in plain words", async () => {
    const state = newState();
    state.history.push(sha("5"));
    const ports = makePorts(state);
    await expect(resolveCloudRef(ports, config, FROM_TRIGGER, trigger(sha("5")))).rejects.toMatchObject({ exitName: "REF_FAILED" });
    await expect(resolveCloudRef(ports, config, FROM_TRIGGER, trigger(sha("5")))).rejects.toThrow(/no recorded last-good release to keep/u);
  });

  it("refuses when the recorded last-good tag moved, is gone, or is off the trunk", async () => {
    const state = world();
    state.history.push(sha("5"));
    state.tags["v0.13.1"] = sha("2"); // the tag was moved since it was recorded
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("5")))).rejects.toThrow(/no longer points at the commit recorded/u);
    delete state.tags["v0.13.1"];
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("5")))).rejects.toThrow(/no longer points/u);
    const off = world();
    off.history.push(sha("5"));
    off.ssm["/rovara-cloud/beta/release/last-good"] = JSON.stringify({ schema: 1, env: "beta", recordedAt: "2026-11-20T00:00:00.000Z", executionId: "e", mode: "release", cloud: { tag: "v0.14.0", sha: sha("9") }, gateway: { digest: "sha256:" + "b".repeat(64) } });
    await expect(resolveCloudRef(makePorts(off), config, FROM_TRIGGER, trigger(sha("5")))).rejects.toThrow(/is not on cloud\/next/u);
  });

  it("two or more release tags on the commit are refused", async () => {
    const state = world();
    state.tags["v0.13.11"] = sha("3"); // v0.13.9 and v0.13.11 on one commit
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("3")))).rejects.toThrow(/carries 2 release tags \(v0.13.11, v0.13.9\)/u);
  });

  it("a prerelease tag on the commit does not count as a release tag", async () => {
    const state = world();
    state.history.push(sha("6"));
    state.tags["v0.16.0-rc1"] = sha("6");
    expect((await resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("6")))).ref).toBe("last-good");
  });

  it("a commit that is not on the trunk, or unknown, is refused even when it carries a tag", async () => {
    const state = world();
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("9")))).rejects.toThrow(/not on cloud\/next/u); // v0.14.0 is on it, but off the trunk
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("e")))).rejects.toThrow(/not on cloud\/next/u);
  });

  it("a missing or malformed CLOUD_SOURCE_COMMIT is refused before git is touched", async () => {
    for (const bad of [null, "", "abc1234", sha("a").toUpperCase(), `${sha("3")}0`, "v0.13.9", "HEAD"]) {
      const state = world();
      await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(bad))).rejects.toMatchObject({ exitName: "REF_FAILED" });
      expect(state.calls).toEqual([]);
    }
    await expect(resolveCloudRef(makePorts(world()), config, FROM_TRIGGER)).rejects.toMatchObject({ exitName: "REF_FAILED" });
  });

  it("a pushed tag OLDER than the last recorded good release is refused; the same, a newer one, and an explicit CLOUD_REF (a deliberate rollback) are not", async () => {
    const state = world();
    state.ssm["/rovara-cloud/beta/release/last-good"] = JSON.stringify({ schema: 1, env: "beta", recordedAt: "2026-11-20T00:00:00.000Z", executionId: "e", mode: "release", cloud: { tag: "v0.13.9", sha: sha("3") }, gateway: { digest: "sha256:" + "b".repeat(64) } });
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("2")))).rejects.toThrow(/v0\.13\.2 is older than v0\.13\.9.*never rolls Cloud back/u);
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("1")))).rejects.toMatchObject({ exitName: "REF_FAILED" });
    expect((await resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("3")))).tag).toBe("v0.13.9");
    expect((await resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("4")))).tag).toBe("v0.13.10");
    expect((await resolveCloudRef(makePorts(state), config, "v0.13.2", trigger(sha("2")))).ref).toBe("CLOUD_REF");
  });

  it("a tag with a HIGHER version number on an older commit is refused too (ancestry, not only the numbers)", async () => {
    const state = world();
    delete state.tags["v0.13.2"];
    state.tags["v0.30.0"] = sha("2"); // a re-cut tag: a high number, but its commit is behind the recorded release
    state.ssm["/rovara-cloud/beta/release/last-good"] = JSON.stringify({ schema: 1, env: "beta", recordedAt: "2026-11-20T00:00:00.000Z", executionId: "e", mode: "release", cloud: { tag: "v0.13.9", sha: sha("3") }, gateway: { digest: "sha256:" + "b".repeat(64) } });
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("2")))).rejects.toThrow(/v0\.30\.0 is older than v0\.13\.9/u);
  });

  it("the literal `latest` is not from-trigger: a source commit next to it is ignored, the newest tag on the trunk wins", async () => {
    expect(await resolveCloudRef(makePorts(world()), config, "latest", trigger(sha("3")))).toEqual({ tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next" });
  });

  it("from-trigger still refuses a pushed tag older than the last recorded good one, and the latest rule does not widen it", async () => {
    const state = world();
    state.ssm["/rovara-cloud/beta/release/last-good"] = JSON.stringify({ schema: 1, env: "beta", recordedAt: "2026-11-20T00:00:00.000Z", executionId: "e", mode: "release", cloud: { tag: "v0.13.9", sha: sha("3") }, gateway: { digest: "sha256:" + "b".repeat(64) } });
    await expect(resolveCloudRef(makePorts(state), config, FROM_TRIGGER, trigger(sha("2")))).rejects.toThrow(/v0\.13\.2 is older than v0\.13\.9/u);
    expect((await resolveCloudRef(makePorts(state), config, "latest", trigger(sha("2")))).tag).toBe("v0.13.10");
  });
});

describe("pipeline stage CLI: live Cloud sha and mode", () => {
  const resolved = (tag: string, at: string) => ({ tag, sha: sha(at), ref: "CLOUD_REF" as const, trunk: "cloud/next" });

  it("reads DeployedCloudSha from the web stack only (the gateway is Code's now), and says when it is absent", async () => {
    const state = newState();
    liveStack(state, stackFor("beta", "web"), { outputs: { DeployedCloudSha: sha("3") } });
    liveStack(state, stackFor("beta", "gateway"));
    expect(await readLiveCloudSha(makePorts(state), stackFor("beta", "web"))).toEqual({ sha: sha("3"), warnings: [] });
    const absent = newState();
    liveStack(absent, stackFor("beta", "web"));
    const none = await readLiveCloudSha(makePorts(absent), stackFor("beta", "web"));
    expect(none.sha).toBeNull();
    expect(none.warnings[0]).toMatch(/unknown/);
    // #1478 phase 2: the gateway is Code's and records a Code commit; whatever Cloud sha an earlier pipeline stamped on it is not read, and never disagrees with the web stack.
    const gatewayOnly = newState();
    liveStack(gatewayOnly, stackFor("beta", "web"));
    liveStack(gatewayOnly, stackFor("beta", "gateway"), { outputs: { DeployedCloudSha: sha("2") } });
    expect((await readLiveCloudSha(makePorts(gatewayOnly), stackFor("beta", "web"))).sha).toBeNull();
    const disagree = newState();
    liveStack(disagree, stackFor("beta", "web"), { outputs: { DeployedCloudSha: sha("3") } });
    liveStack(disagree, stackFor("beta", "gateway"), { outputs: { DeployedCloudSha: sha("2") } });
    expect(await readLiveCloudSha(makePorts(disagree), stackFor("beta", "web"))).toEqual({ sha: sha("3"), warnings: [] });
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
