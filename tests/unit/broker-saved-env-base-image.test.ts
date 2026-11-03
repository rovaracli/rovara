// Saved project images (SV wiring): the base image digest of the key is the digest of the WORKER image (the sandbox image is the worker image), read from the worker settings with the reader the session steps launch
// workers with. Only a reference pinned by digest has one; a tag, a failed read or a missing setting gives none, and so no key (fail closed).
import { describe, expect, it, vi } from "vitest";
import { MODEL_PROXY_URL_PARAMETER, BOOT_STAGE2_SHA256_PARAMETER, WORKER_SETTING_PARAMETERS } from "@agentx/contracts";
import { baseImageDigestOfWorkerImage, savedEnvBaseImageDigestReader, SAVED_ENV_BASE_IMAGE_CACHE_MS } from "../../packages/broker/src/aws/broker/saved-env-real.js";

const PREFIX = "/agentx/staging/";
const DIGEST = `sha256:${"a".repeat(64)}`;
const settings = (image: string | undefined, over: Record<string, string | undefined> = {}): Record<string, string> => {
  const base: Record<string, string> = {
    ...Object.fromEntries(Object.values(WORKER_SETTING_PARAMETERS).map((name) => [`${PREFIX}${name}`, "none"])),
    [`${PREFIX}${WORKER_SETTING_PARAMETERS.modelProvider}`]: "amazon-bedrock",
    [`${PREFIX}${WORKER_SETTING_PARAMETERS.modelId}`]: "us.anthropic.claude-sonnet-4-6",
    [`${PREFIX}${WORKER_SETTING_PARAMETERS.promptCacheRetention}`]: "long",
    [`${PREFIX}${MODEL_PROXY_URL_PARAMETER}`]: "https://proxy.example.test",
    [`${PREFIX}${BOOT_STAGE2_SHA256_PARAMETER}`]: "5c".repeat(32),
  };
  if (image !== undefined) base[`${PREFIX}${WORKER_SETTING_PARAMETERS.workerImage}`] = image;
  for (const [key, value] of Object.entries(over)) { if (value === undefined) delete base[key]; else base[key] = value; }
  return base;
};
const ssm = (store: Record<string, string>) => vi.fn(async (names: string[]) => ({
  Parameters: names.filter((name) => name in store).map((name) => ({ Name: name, Value: store[name] })), InvalidParameters: names.filter((name) => !(name in store)),
}));

describe("the digest of an image reference", () => {
  it("is the digest of a reference pinned by digest, and nothing else", () => {
    expect(baseImageDigestOfWorkerImage(`111122223333.dkr.ecr.us-west-2.amazonaws.com/agentx-worker@${DIGEST}`)).toBe(DIGEST);
    for (const bad of [undefined, "", "registry/agentx-worker:latest", "registry/agentx-worker:1.2.3", `registry/agentx-worker@sha256:${"a".repeat(63)}`, `registry/agentx-worker@sha256:${"A".repeat(64)}`, `registry/agentx-worker@sha1:${"a".repeat(40)}`, `registry/agentx-worker@${DIGEST} extra`, `${DIGEST}`]) {
      expect(baseImageDigestOfWorkerImage(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("the base image digest the install says", () => {
  it("is the worker image setting's digest, read under the environment's prefix with the session steps' reader and never the proxy URL or the boot hash", async () => {
    const read = ssm(settings(`registry/agentx-worker@${DIGEST}`));
    expect(await savedEnvBaseImageDigestReader(read, PREFIX)()).toBe(DIGEST);
    const asked = read.mock.calls.flatMap(([names]) => names);
    expect(asked).toContain(`${PREFIX}${WORKER_SETTING_PARAMETERS.workerImage}`);
    expect(asked).not.toContain(`${PREFIX}${MODEL_PROXY_URL_PARAMETER}`);
    expect(asked).not.toContain(`${PREFIX}${BOOT_STAGE2_SHA256_PARAMETER}`);
  });

  it("is none for an image that is a tag, a missing or unreadable setting, and a read that fails", async () => {
    expect(await savedEnvBaseImageDigestReader(ssm(settings("registry/agentx-worker:latest")), PREFIX)()).toBeUndefined();
    expect(await savedEnvBaseImageDigestReader(ssm(settings(undefined)), PREFIX)()).toBeUndefined();
    expect(await savedEnvBaseImageDigestReader(ssm(settings(`registry/w@${DIGEST}`, { [`${PREFIX}${WORKER_SETTING_PARAMETERS.modelProvider}`]: undefined })), PREFIX)()).toBeUndefined();
    expect(await savedEnvBaseImageDigestReader(async () => { throw new Error("AccessDeniedException"); }, PREFIX)()).toBeUndefined();
    expect(await savedEnvBaseImageDigestReader(ssm(settings(`registry/w@${DIGEST}`)), "/other/prefix/")()).toBeUndefined();
  });

  it("does not keep the answer 'none' (a tag today, a digest after the next release)", async () => {
    const store = settings("registry/agentx-worker:latest");
    const digest = savedEnvBaseImageDigestReader(ssm(store), PREFIX);
    expect(await digest()).toBeUndefined();
    store[`${PREFIX}${WORKER_SETTING_PARAMETERS.workerImage}`] = `registry/agentx-worker@${DIGEST}`;
    expect(await digest()).toBe(DIGEST);
  });

  it("keeps a good answer for a minute and asks again after, and never keeps a failure", async () => {
    let now = 1_000_000;
    const store = settings(`registry/w@${DIGEST}`);
    const read = ssm(store);
    const digest = savedEnvBaseImageDigestReader(read, PREFIX, () => now);
    await digest();
    const calls = read.mock.calls.length;
    await digest();
    expect(read.mock.calls.length).toBe(calls);
    // a release moves the image: seen after the minute
    store[`${PREFIX}${WORKER_SETTING_PARAMETERS.workerImage}`] = `registry/w@sha256:${"c".repeat(64)}`;
    now += SAVED_ENV_BASE_IMAGE_CACHE_MS + 1;
    expect(await digest()).toBe(`sha256:${"c".repeat(64)}`);
    // a failure after that is none, and is asked again at once
    let failing = true;
    const flaky = savedEnvBaseImageDigestReader(async (names) => { if (failing) throw new Error("down"); return ssm(settings(`registry/w@${DIGEST}`))(names); }, PREFIX, () => now);
    expect(await flaky()).toBeUndefined();
    failing = false;
    expect(await flaky()).toBe(DIGEST);
  });
});
