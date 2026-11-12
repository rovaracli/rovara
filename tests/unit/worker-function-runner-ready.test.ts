import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_PLAN_FEATURE } from "@rovara-code/contracts";
import { FUNCTION_RUNNER_AGENT_HOST_PATH, TEST_SERVICES_FUNCTIONS_PLAN_FEATURE } from "@agentx/cloud-contracts";
import { FUNCTION_RUNNER_PREPULL_LIST_URL, functionRunnerAdvertisedFeatures, functionRunnerReadiness } from "../../packages/worker/src/function-runner-ready.js";

// Slice 4, lane C1: the worker offers the function runner only for what boot-stage2.sh left (ready, runsc, the agent at its path), the runner's images listed and none reported as not pulled.
const REGISTRY = "944937319445.dkr.ecr.us-west-2.amazonaws.com";
const image = (id: string, repository: string, digest: string, platforms: string[] = ["linux/arm64"]) => ({ id, repository, digest, platforms });
const GOOD = { schemaVersion: 1, catalogRevision: 4, images: [image("function-agent@r1", "svc/function-agent", "a".repeat(64)), image("lambda-python@3.12", "svc/lambda-python", "b".repeat(64)), image("lambda-nodejs@22", "svc/lambda-nodejs", "c".repeat(64))] };
const READY = { AGENTX_FUNCTION_RUNNER: "ready", AGENTX_FUNCTION_RUNNER_RUNTIME: "runsc", AGENTX_FUNCTION_RUNNER_AGENT: FUNCTION_RUNNER_AGENT_HOST_PATH, AGENTX_TEST_SERVICES_REGISTRY: REGISTRY, AGENTX_TEST_SERVICES_ENV: "staging" } as NodeJS.ProcessEnv;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function listFile(value: unknown): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), "fr-ready-"));
  roots.push(dir);
  const file = join(dir, "function-runner-prepull.json");
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  return pathToFileURL(file);
}

describe("functionRunnerReadiness", () => {
  it("reads the image's own list from beside prepull.json, and the shipped (empty, unpinned) list is not ready", () => {
    expect(FUNCTION_RUNNER_PREPULL_LIST_URL.pathname.endsWith("/packages/worker/service-catalog/function-runner-prepull.json")).toBe(true);
    expect(functionRunnerReadiness(READY)).toEqual({ ready: false, reason: "no_list" });
  });

  it("is ready with the boot's note and a full list, and hands out digest references for the runtimes the list has", async () => {
    const readiness = functionRunnerReadiness(READY, await listFile(GOOD));
    expect(readiness.ready).toBe(true);
    if (!readiness.ready) return;
    expect(readiness.runtime).toBe("runsc");
    expect(readiness.agentHostPath).toBe("/opt/rovara/function-runner/agent");
    expect(readiness.imageForRuntime("python3.12")).toBe(`${REGISTRY}/rovara-catalog/staging/svc/lambda-python@sha256:${"b".repeat(64)}`);
    expect(readiness.imageForRuntime("nodejs22.x")).toBe(`${REGISTRY}/rovara-catalog/staging/svc/lambda-nodejs@sha256:${"c".repeat(64)}`);
    // Not in the list, or not a runtime: undefined (the function is then Rovara.Unsupported), never a guess.
    for (const runtime of ["python3.13", "java21", "python3.12-arm64", ""]) expect(readiness.imageForRuntime(runtime), runtime).toBeUndefined();
  });

  it("is off with no note, and not ready for anything but exactly `ready`", async () => {
    const list = await listFile(GOOD);
    expect(functionRunnerReadiness({ ...READY, AGENTX_FUNCTION_RUNNER: undefined }, list)).toEqual({ ready: false, reason: "off" });
    for (const state of ["unavailable", "READY", "ready ", "1", "true", "on"]) expect(functionRunnerReadiness({ ...READY, AGENTX_FUNCTION_RUNNER: state }, list), state).toEqual({ ready: false, reason: "not_ready" });
  });

  it("refuses an environment that names another runtime or another agent path, or no registry (a flag on with no runtime, an agent that boot did not install)", async () => {
    const list = await listFile(GOOD);
    for (const change of [{ AGENTX_FUNCTION_RUNNER_RUNTIME: "runc" }, { AGENTX_FUNCTION_RUNNER_RUNTIME: undefined }, { AGENTX_FUNCTION_RUNNER_AGENT: "/tmp/agent" }, { AGENTX_FUNCTION_RUNNER_AGENT: undefined }, { AGENTX_TEST_SERVICES_REGISTRY: undefined }, { AGENTX_TEST_SERVICES_ENV: undefined }]) {
      expect(functionRunnerReadiness({ ...READY, ...change }, list), JSON.stringify(change)).toEqual({ ready: false, reason: "bad_environment" });
    }
  });

  it("is not ready when a runner repository did not pre-pull, or the whole services pre-pull is withheld; another repository failing is no matter", async () => {
    const list = await listFile(GOOD);
    for (const missing of ["all", "svc/lambda-python", "svc/function-agent,svc/postgres", "not a list"]) expect(functionRunnerReadiness({ ...READY, AGENTX_TEST_SERVICES_NOT_PULLED: missing }, list), missing).toEqual({ ready: false, reason: "not_pulled" });
    expect(functionRunnerReadiness({ ...READY, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/postgres" }, list).ready).toBe(true);
  });

  it("is not ready for a list that is missing, too large, not JSON, tagged, x86, for another repository, without the agent or without a runtime image", async () => {
    const bad = async (value: unknown) => functionRunnerReadiness(READY, await listFile(value));
    expect(functionRunnerReadiness(READY, pathToFileURL(join(tmpdir(), "no-such-fr-list.json")))).toEqual({ ready: false, reason: "no_list" });
    expect(await bad("{not json")).toEqual({ ready: false, reason: "no_list" });
    expect(await bad(" ".repeat(20_000))).toEqual({ ready: false, reason: "no_list" });
    expect(await bad({ ...GOOD, images: [image("function-agent@r1", "svc/function-agent", "latest"), GOOD.images[1]] })).toEqual({ ready: false, reason: "no_list" });
    expect(await bad({ ...GOOD, images: [GOOD.images[0], image("lambda-python@3.12", "svc/lambda-python", "b".repeat(64), ["linux/amd64"])] })).toEqual({ ready: false, reason: "no_list" });
    expect(await bad({ ...GOOD, images: [GOOD.images[0], image("lambda-python@3.12", "svc/postgres", "b".repeat(64))] })).toEqual({ ready: false, reason: "no_list" });
    expect(await bad({ ...GOOD, images: [GOOD.images[1], GOOD.images[2]] })).toEqual({ ready: false, reason: "no_list" });
    expect(await bad({ ...GOOD, images: [GOOD.images[0]] })).toEqual({ ready: false, reason: "no_list" });
  });
});

describe("functionRunnerAdvertisedFeatures", () => {
  it("adds the feature only when the runner is ready AND the worker already offers the emulator", async () => {
    const list = await listFile(GOOD);
    const withAws = [TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE];
    expect(functionRunnerAdvertisedFeatures(withAws, READY, list)).toEqual([TEST_SERVICES_FUNCTIONS_PLAN_FEATURE]);
    expect(functionRunnerAdvertisedFeatures([TEST_SERVICES_PLAN_FEATURE], READY, list)).toEqual([]);
    expect(functionRunnerAdvertisedFeatures([], READY, list)).toEqual([]);
    expect(functionRunnerAdvertisedFeatures(withAws, { ...READY, AGENTX_FUNCTION_RUNNER: "unavailable" }, list)).toEqual([]);
    expect(functionRunnerAdvertisedFeatures(withAws, {}, list)).toEqual([]);
  });

  it("offers nothing on a worker with no boot note, as every worker is today (the shipped list is empty and nothing launches the boot step)", () => {
    expect(functionRunnerAdvertisedFeatures([TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE], {})).toEqual([]);
  });
});
