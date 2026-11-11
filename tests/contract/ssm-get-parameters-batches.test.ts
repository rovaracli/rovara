import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SSM_GET_PARAMETERS_MAX_NAMES, getParametersInBatches } from "@rovara-code/contracts";
import { readWorkerSettings } from "../../packages/broker/src/aws/session-steps.js";
import { BOOT_STAGE2_SHA256_PARAMETER, MODEL_PROXY_URL_PARAMETER, WORKER_SETTING_PARAMETERS } from "@rovara-code/contracts";

/** SSM GetParameters as it behaves: more than 10 names is a ValidationException; unknown names come back in InvalidParameters. */
function fakeSsm(store: Record<string, string>) {
  return vi.fn(async (names: readonly string[]) => {
    if (names.length > SSM_GET_PARAMETERS_MAX_NAMES) {
      throw new Error(`ValidationException: Value '[${names.join(", ")}]' at 'names' failed to satisfy constraint: Member must have length less than or equal to 10`);
    }
    return {
      Parameters: names.filter((name) => name in store).map((name) => ({ Name: name, Value: store[name] })),
      InvalidParameters: names.filter((name) => !(name in store)),
    };
  });
}

describe("SSM GetParameters batching", () => {
  it("makes more than one call for 11 names, each with at most 10, and merges the results", async () => {
    const names = Array.from({ length: 11 }, (_, index) => `/p/${index}`);
    const read = fakeSsm(Object.fromEntries(names.map((name) => [name, `v${name}`])));
    const result = await getParametersInBatches(names, read);
    expect(read.mock.calls.length).toBeGreaterThan(1);
    for (const [batch] of read.mock.calls) expect(batch.length).toBeLessThanOrEqual(10);
    expect(result.Parameters.map((parameter) => parameter.Name).sort()).toEqual([...names].sort());
    expect(result.InvalidParameters).toEqual([]);
  });

  it("makes one call for 10 names and none for no names", async () => {
    const read = fakeSsm({});
    await getParametersInBatches(Array.from({ length: 10 }, (_, index) => `/p/${index}`), read);
    expect(read).toHaveBeenCalledTimes(1);
    await getParametersInBatches([], read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps InvalidParameters from every batch", async () => {
    const names = Array.from({ length: 25 }, (_, index) => `/p/${index}`);
    const read = fakeSsm(Object.fromEntries(names.filter((name) => name !== "/p/3" && name !== "/p/24").map((name) => [name, "x"])));
    const result = await getParametersInBatches(names, read);
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.InvalidParameters.sort()).toEqual(["/p/24", "/p/3"]);
    expect(result.Parameters).toHaveLength(23);
  });

  it("fails whole when a batch fails", async () => {
    const read = vi.fn(async (batch: readonly string[]) => {
      if (batch.includes("/p/12")) throw new Error("AccessDeniedException");
      return { Parameters: [], InvalidParameters: [] };
    });
    await expect(getParametersInBatches(Array.from({ length: 15 }, (_, index) => `/p/${index}`), read)).rejects.toThrow("AccessDeniedException");
  });
});

describe("the session steps' worker settings read", () => {
  const prefix = "/agentx/staging/";
  const everything = (): Record<string, string> => ({
    ...Object.fromEntries(Object.values(WORKER_SETTING_PARAMETERS).map((name) => [`${prefix}${name}`, "none"])),
    [`${prefix}${WORKER_SETTING_PARAMETERS.workerImage}`]: `111122223333.dkr.ecr.us-west-2.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`,
    [`${prefix}${WORKER_SETTING_PARAMETERS.modelProvider}`]: "amazon-bedrock",
    [`${prefix}${WORKER_SETTING_PARAMETERS.modelId}`]: "us.anthropic.claude-sonnet-4-6",
    [`${prefix}${WORKER_SETTING_PARAMETERS.promptCacheRetention}`]: "long",
    [`${prefix}${MODEL_PROXY_URL_PARAMETER}`]: "https://proxy.example.test",
    [`${prefix}${BOOT_STAGE2_SHA256_PARAMETER}`]: "5c".repeat(32),
  });

  it("asks for 11 names at the staging configuration (a named environment) and never more than 10 per call", async () => {
    const read = fakeSsm(everything());
    const settings = await readWorkerSettings(read, { prefix, modelProxyRequired: true });
    const asked = read.mock.calls.flatMap(([batch]) => batch);
    expect(asked).toHaveLength(Object.keys(WORKER_SETTING_PARAMETERS).length + 2);
    expect(asked.length).toBeGreaterThan(SSM_GET_PARAMETERS_MAX_NAMES);
    for (const [batch] of read.mock.calls) expect(batch.length).toBeLessThanOrEqual(SSM_GET_PARAMETERS_MAX_NAMES);
    expect(settings.modelProxyUrl).toBe("https://proxy.example.test");
    expect(settings.bootStage2Sha256).toBe("5c".repeat(32));
  });

  it("asks for the nine worker settings only in the legacy deployment", async () => {
    const read = fakeSsm(everything());
    await readWorkerSettings(read, { prefix, modelProxyRequired: false });
    expect(read.mock.calls.flatMap(([batch]) => batch)).toHaveLength(Object.keys(WORKER_SETTING_PARAMETERS).length);
  });

  it("still fails closed on a missing required parameter, whichever batch it falls in", async () => {
    for (const missing of [WORKER_SETTING_PARAMETERS.workerImage, WORKER_SETTING_PARAMETERS.modelId, WORKER_SETTING_PARAMETERS.promptCacheRetention]) {
      const store = everything();
      delete store[`${prefix}${missing}`];
      await expect(readWorkerSettings(fakeSsm(store), { prefix, modelProxyRequired: true })).rejects.toThrow(`SSM parameter ${prefix}${missing} is missing`);
    }
  });
});

describe("every GetParameters caller", () => {
  const root = new URL("../..", import.meta.url).pathname;
  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      if (entry === "node_modules" || entry === "dist" || entry === "cdk.out") return [];
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
    });
  }

  it("goes through getParametersInBatches, so none can exceed 10 names", () => {
    const callers = ["packages", "scripts", "infra"].flatMap((directory) => sources(join(root, directory)))
      .filter((path) => /new GetParametersCommand\(/.test(readFileSync(path, "utf8")));
    expect(callers.length).toBeGreaterThan(0);
    for (const path of callers) {
      const text = readFileSync(path, "utf8");
      const calls = text.match(/new GetParametersCommand\(/g)!.length;
      expect(text.match(/getParametersInBatches\(/g)?.length ?? 0, path).toBeGreaterThanOrEqual(calls);
    }
  });
});
