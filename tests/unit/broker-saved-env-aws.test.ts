// Saved project images (SV wiring): the ECR and STS adapters. Every ECR call is made with a client built from the SESSION's credentials, never the broker's own; errors map to fixed outcomes.
import { describe, expect, it } from "vitest";
import { savedEnvRegistryPort, savedEnvSessionPorts, type AwsSender, type SavedEnvAwsClients } from "../../packages/broker/src/aws/broker/saved-env-aws.js";
import { mintManageSession, mintPullSession, type SavedEnvSessionConfig } from "../../packages/broker/src/test-env/saved-env-session.js";
import { expectedRepositoryPolicy } from "../../packages/broker/src/test-env/saved-env-session.js";

const CREDS = { accessKeyId: "AKIAFAKEFAKEFAKE", secretAccessKey: "secret-a", sessionToken: "token-a" };
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const REPO = "rovara-env/test/abc";
const named = (name: string): Error => Object.assign(new Error(name), { name });

interface Call { command: string; input: Record<string, unknown>; credentials?: unknown }
function bench(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const clients: SavedEnvAwsClients = {
    sts: { send: async (command) => { const call = { command: (command as object).constructor.name, input: (command as { input: Record<string, unknown> }).input }; calls.push(call); return handler(call); } },
    ecr: (credentials) => ({ send: async (command) => { const call = { command: (command as object).constructor.name, input: (command as { input: Record<string, unknown> }).input, credentials }; calls.push(call); return handler(call); } }) as AwsSender,
  };
  return { calls, clients };
}

describe("the registry port", () => {
  it("makes every call with the session's credentials", async () => {
    const { calls, clients } = bench((call) => (call.command === "DescribeImagesCommand" ? { imageDetails: [] } : call.command === "BatchDeleteImageCommand" ? {} : {}));
    const port = savedEnvRegistryPort(clients);
    await port.listImages(CREDS, REPO);
    await port.batchDelete(CREDS, REPO, ["sha256:a"]);
    await port.deleteRepository(CREDS, REPO);
    await port.startScan(CREDS, REPO, "sha256:a");
    expect(calls.map((call) => call.command)).toEqual(["DescribeImagesCommand", "BatchDeleteImageCommand", "DeleteRepositoryCommand", "StartImageScanCommand"]);
    for (const call of calls) expect(call.credentials).toEqual(CREDS);
  });

  it("lists every page, with each image's digest, tags and push time, and says absent for a repository that does not exist", async () => {
    const pages = [{ imageDetails: [{ imageDigest: "sha256:1", imageTags: ["k1"], imagePushedAt: new Date("2026-11-01T00:00:00Z") }], nextToken: "t2" }, { imageDetails: [{ imageDigest: "sha256:2", imagePushedAt: new Date("2026-11-02T00:00:00Z") }, { imageTags: ["no-digest"] }] }];
    const { calls, clients } = bench(() => pages.shift());
    expect(await savedEnvRegistryPort(clients).listImages(CREDS, REPO)).toEqual([
      { digest: "sha256:1", tags: ["k1"], pushedAt: "2026-11-01T00:00:00.000Z" }, { digest: "sha256:2", tags: [], pushedAt: "2026-11-02T00:00:00.000Z" },
    ]);
    expect(calls[1]?.input.nextToken).toBe("t2");
    const missing = bench(() => { throw named("RepositoryNotFoundException"); });
    expect(await savedEnvRegistryPort(missing.clients).listImages(CREDS, REPO)).toBe("absent");
    const denied = bench(() => { throw named("AccessDeniedException"); });
    await expect(savedEnvRegistryPort(denied.clients).listImages(CREDS, REPO)).rejects.toThrow();
  });

  it("never returns a cut-short listing as if it were everything", async () => {
    const { clients } = bench(() => ({ imageDetails: [], nextToken: "again" }));
    await expect(savedEnvRegistryPort(clients).listImages(CREDS, REPO)).rejects.toThrow(/more images/u);
  });

  it("deletes in batches of 100, treats an image already gone as deleted, and throws on any other failure", async () => {
    const digests = Array.from({ length: 250 }, (_, index) => `sha256:${String(index).padStart(64, "0")}`);
    const { calls, clients } = bench(() => ({ failures: [{ failureCode: "ImageNotFound" }] }));
    await savedEnvRegistryPort(clients).batchDelete(CREDS, REPO, digests);
    expect(calls.map((call) => (call.input.imageIds as unknown[]).length)).toEqual([100, 100, 50]);
    const refused = bench(() => ({ failures: [{ failureCode: "KmsError" }] }));
    await expect(savedEnvRegistryPort(refused.clients).batchDelete(CREDS, REPO, ["sha256:a"])).rejects.toThrow();
  });

  it("deletes a repository with its images (force) and counts a missing repository as absent", async () => {
    const { calls, clients } = bench(() => ({}));
    expect(await savedEnvRegistryPort(clients).deleteRepository(CREDS, REPO)).toBe("deleted");
    expect(calls[0]?.input).toEqual({ repositoryName: REPO, force: true });
    const missing = bench(() => { throw named("RepositoryNotFoundException"); });
    expect(await savedEnvRegistryPort(missing.clients).deleteRepository(CREDS, REPO)).toBe("absent");
    const other = bench(() => { throw named("ServerException"); });
    await expect(savedEnvRegistryPort(other.clients).deleteRepository(CREDS, REPO)).rejects.toThrow();
  });

  it("starts a scan for the digest it was given", async () => {
    const { calls, clients } = bench(() => ({}));
    await savedEnvRegistryPort(clients).startScan(CREDS, REPO, "sha256:a");
    expect(calls[0]?.input).toEqual({ repositoryName: REPO, imageId: { imageDigest: "sha256:a" } });
  });
});

describe("the session ports", () => {
  const bindings = { readApproved: async () => ({ revision: 1, digest: "d" }), proveHolds: async () => true, now: () => 1 };

  it("assumes the role with the policy and duration it was given and returns the session", async () => {
    const { calls, clients } = bench(() => ({ Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c", Expiration: new Date(5_000) } }));
    const assumed = await savedEnvSessionPorts(clients, bindings).assume({ roleArn: "arn:aws:iam::1:role/x", sessionName: "n", policy: "{}", durationSeconds: 900 });
    expect(assumed).toEqual({ credentials: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c" }, expiresAtMs: 5_000 });
    expect(calls[0]?.input).toEqual({ RoleArn: "arn:aws:iam::1:role/x", RoleSessionName: "n", Policy: "{}", DurationSeconds: 900 });
    const empty = bench(() => ({}));
    await expect(savedEnvSessionPorts(empty.clients, bindings).assume({ roleArn: "r", sessionName: "n", policy: "{}", durationSeconds: 900 })).rejects.toThrow();
  });

  it("gets the registry token with the session's credentials, and hands on the password and host only", async () => {
    const { calls, clients } = bench(() => ({ authorizationData: [{ authorizationToken: Buffer.from("AWS:pw-value").toString("base64"), expiresAt: new Date(9_000), proxyEndpoint: "https://111122223333.dkr.ecr.us-west-2.amazonaws.com" }] }));
    expect(await savedEnvSessionPorts(clients, bindings).authorizationToken(CREDS)).toEqual({ password: "pw-value", registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", expiresAtMs: 9_000 });
    expect(calls[0]?.credentials).toEqual(CREDS);
    const other = bench(() => ({ authorizationData: [{ authorizationToken: Buffer.from("root:pw").toString("base64"), expiresAt: new Date(9_000), proxyEndpoint: "https://x" }] }));
    await expect(savedEnvSessionPorts(other.clients, bindings).authorizationToken(CREDS)).rejects.toThrow();
  });

  it("describes a repository with its policy, says absent when it does not exist, and has no policy text when there is no policy", async () => {
    const { clients } = bench((call) => (call.command === "DescribeRepositoriesCommand"
      ? { repositories: [{ encryptionConfiguration: { encryptionType: "KMS", kmsKey: KMS }, imageTagMutability: "IMMUTABLE" }] } : { policyText: "{\"p\":1}" }));
    expect(await savedEnvSessionPorts(clients, bindings).inspectRepository(CREDS, REPO)).toEqual({ encryptionType: "KMS", kmsKey: KMS, imageTagMutability: "IMMUTABLE", policyText: "{\"p\":1}" });
    const noPolicy = bench((call) => { if (call.command === "GetRepositoryPolicyCommand") throw named("RepositoryPolicyNotFoundException"); return { repositories: [{ imageTagMutability: "MUTABLE" }] }; });
    expect(await savedEnvSessionPorts(noPolicy.clients, bindings).inspectRepository(CREDS, REPO)).toMatchObject({ imageTagMutability: "MUTABLE", policyText: undefined });
    const absent = bench(() => { throw named("RepositoryNotFoundException"); });
    expect(await savedEnvSessionPorts(absent.clients, bindings).inspectRepository(CREDS, REPO)).toBe("absent");
    const denied = bench((call) => { if (call.command === "GetRepositoryPolicyCommand") throw named("AccessDeniedException"); return { repositories: [{}] }; });
    await expect(savedEnvSessionPorts(denied.clients, bindings).inspectRepository(CREDS, REPO)).rejects.toThrow();
  });

  it("works with the broker's session functions: a pull login is minted only for a repository that matches the template", async () => {
    const config: SavedEnvSessionConfig = { enabled: true, env: "test", scope: { partition: "aws", region: "us-west-2", account: "111122223333" }, kmsKeyArn: KMS };
    const make = (kms: string) => bench((call) => {
      if (call.command === "AssumeRoleCommand") return { Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c", Expiration: new Date(Date.now() + 900_000) } };
      if (call.command === "DescribeRepositoriesCommand") return { repositories: [{ encryptionConfiguration: { encryptionType: "KMS", kmsKey: kms }, imageTagMutability: "IMMUTABLE" }] };
      if (call.command === "GetRepositoryPolicyCommand") return { policyText: JSON.stringify(expectedRepositoryPolicy(config)) };
      return { authorizationData: [{ authorizationToken: Buffer.from("AWS:" + "p".repeat(40)).toString("base64"), expiresAt: new Date(Date.now() + 3_600_000), proxyEndpoint: "https://111122223333.dkr.ecr.us-west-2.amazonaws.com" }] };
    });
    const good = make(KMS);
    const approved = { revision: 1, digest: "d" };
    const session = await mintPullSession(config, savedEnvSessionPorts(good.clients, { ...bindings, readApproved: async () => approved }), { orgId: "org-1", projectId: "p", approved });
    expect(session).toMatchObject({ ok: true });
    // the manage session's ECR calls and the token call all carry session credentials (never the broker's)
    expect(good.calls.filter((call) => call.command !== "AssumeRoleCommand").every((call) => (call.credentials as { sessionToken?: string } | undefined)?.sessionToken === "c")).toBe(true);
    const wrongKey = make("arn:aws:kms:us-west-2:111122223333:key/other");
    expect(await mintPullSession(config, savedEnvSessionPorts(wrongKey.clients, { ...bindings, readApproved: async () => approved }), { orgId: "org-1", projectId: "p", approved })).toEqual({ ok: false, reason: "unavailable" });
    expect((await mintManageSession(config, savedEnvSessionPorts(good.clients, bindings), { orgId: "org-1", projectId: "p" })).ok).toBe(true);
  });
});
