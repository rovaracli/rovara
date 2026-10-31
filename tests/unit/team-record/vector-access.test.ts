import { teamRecordVectorIndexName } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { S3VectorsIndex, type S3VectorsPort } from "../../../packages/broker/src/team-record/s3-vectors-index.js";
import { WorkspaceVectorPorts, createAssume, createStsAssumePort, openWorkspaceIndex, workspaceVectorSessionPolicy, type SessionPolicyInput } from "../../../packages/broker/src/team-record/vector-access.js";

const base = { region: "us-west-2", account: "111122223333", bucket: "rovara-record-vectors" };
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

describe("session policy per workspace", () => {
  it("reaches the one index of one workspace, with no wildcard on the index and no delete-index or bucket right", () => {
    const policy = workspaceVectorSessionPolicy({ ...base, workspaceId: "ws-a" });
    const text = JSON.stringify(policy);
    expect(text).toContain(`bucket/rovara-record-vectors/index/${teamRecordVectorIndexName("ws-a")}"`);
    expect(text).not.toContain("index/*");
    expect(text).not.toContain(teamRecordVectorIndexName("ws-b"));
    expect(text).not.toMatch(/DeleteIndex|CreateIndex|DeleteVectorBucket|ListIndexes/);
    expect(text.length).toBeLessThan(2048);
  });
  it("adds index creation only when asked, and the key only when there is one", () => {
    expect(JSON.stringify(workspaceVectorSessionPolicy({ ...base, workspaceId: "ws-a", allowCreateIndex: true }))).toContain("s3vectors:CreateIndex");
    expect(JSON.stringify(workspaceVectorSessionPolicy({ ...base, workspaceId: "ws-a" }))).not.toContain("kms:");
    expect(JSON.stringify(workspaceVectorSessionPolicy({ ...base, workspaceId: "ws-a", kmsKeyArn: KMS }))).toContain(KMS);
  });
  it("refuses a workspace id that is not a safe id", () => {
    expect(() => workspaceVectorSessionPolicy({ ...base, workspaceId: 'a"/index/*' })).toThrow(/safe id/);
  });
});

describe("workspace ports", () => {
  const fakePort = (name: string): S3VectorsPort => ({ name } as unknown as S3VectorsPort);
  function make(clock: { t: number }, ttl = 3_600_000) {
    const assumed: Array<{ workspaceId: string; sessionPolicy: string }> = [];
    const ports = new WorkspaceVectorPorts({
      now: () => clock.t,
      policyFor: (workspaceId, bucket): SessionPolicyInput => ({ ...base, bucket, workspaceId }),
      assume: async (request) => { assumed.push(request); return { port: fakePort(request.workspaceId + assumed.length), expiresAtMs: clock.t + ttl }; },
      maxEntries: 2,
    });
    return { ports, assumed };
  }
  it("assumes one session per workspace, each with its own policy, and reuses it until shortly before it expires", async () => {
    const clock = { t: 0 };
    const { ports, assumed } = make(clock);
    const a1 = await ports.get("ws-a", "rovara-record-vectors");
    const a2 = await ports.get("ws-a", "rovara-record-vectors");
    const b = await ports.get("ws-b", "rovara-record-vectors");
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
    expect(assumed).toHaveLength(2);
    expect(assumed[0]!.sessionPolicy).toContain(teamRecordVectorIndexName("ws-a"));
    expect(assumed[0]!.sessionPolicy).not.toContain(teamRecordVectorIndexName("ws-b"));
    clock.t = 3_600_000 - 200_000;
    await ports.get("ws-a", "rovara-record-vectors");
    expect(assumed).toHaveLength(3);
  });
  it("bounds the cache", async () => {
    const clock = { t: 0 };
    const { ports, assumed } = make(clock);
    for (const id of ["ws-a", "ws-b", "ws-c", "ws-a"]) await ports.get(id, "rovara-record-vectors");
    expect(assumed).toHaveLength(4);
  });
  it("the index refuses a bucket name that is not valid (the bucket comes from the workspace record, not from a list)", () => {
    const port = {} as S3VectorsPort;
    expect(() => new S3VectorsIndex({ port, bucket: "Bad Bucket", workspaceId: "ws1", dimension: 4 })).toThrow(/bucket name/);
  });
});

describe("STS adapter (I-8)", () => {
  const expiration = new Date(Date.UTC(2026, 5, 1, 13, 0, 0));
  it("assumes the data role with the session policy of the one workspace and builds the port from the session credentials", async () => {
    const sent: Array<{ RoleArn?: string; RoleSessionName?: string; Policy?: string; DurationSeconds?: number }> = [];
    const client = { send: async (command: { input: (typeof sent)[number] }) => { sent.push(command.input); return { Credentials: { AccessKeyId: "AKIA-test", SecretAccessKey: "s", SessionToken: "t", Expiration: expiration } }; } };
    const used: string[] = [];
    const ports = new WorkspaceVectorPorts({
      now: () => 0,
      policyFor: (workspaceId, bucket) => ({ ...base, bucket, workspaceId }),
      assume: createAssume({
        sts: createStsAssumePort(client as never),
        roleArn: "arn:aws:iam::111122223333:role/data",
        portFromCredentials: (credentials) => { used.push(credentials.accessKeyId); return {} as S3VectorsPort; },
      }),
    });
    const index = await openWorkspaceIndex({ ports, workspaceId: "ws-a", bucket: "rovara-record-vectors", dimension: 4 });
    expect(index).toBeInstanceOf(S3VectorsIndex);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ RoleArn: "arn:aws:iam::111122223333:role/data", DurationSeconds: 3600 });
    expect(sent[0]!.RoleSessionName).toMatch(/^team-record-[0-9a-f]{24}$/);
    expect(sent[0]!.Policy).toContain(teamRecordVectorIndexName("ws-a"));
    expect(sent[0]!.Policy).not.toContain("index/*");
    expect(used).toEqual(["AKIA-test"]);
    await openWorkspaceIndex({ ports, workspaceId: "ws-a", bucket: "rovara-record-vectors", dimension: 4 });
    expect(sent).toHaveLength(1);
  });
  it("gives a different session (and policy) to every workspace", async () => {
    const policies: string[] = [];
    const client = { send: async (command: { input: { Policy: string } }) => { policies.push(command.input.Policy); return { Credentials: { AccessKeyId: "a", SecretAccessKey: "s", SessionToken: "t", Expiration: expiration } }; } };
    const ports = new WorkspaceVectorPorts({ now: () => 0, policyFor: (workspaceId, bucket) => ({ ...base, bucket, workspaceId }), assume: createAssume({ sts: createStsAssumePort(client as never), roleArn: "arn:aws:iam::111122223333:role/data", portFromCredentials: () => ({}) as S3VectorsPort }) });
    await ports.get("ws-a", "rovara-record-vectors");
    await ports.get("ws-b", "rovara-record-vectors");
    expect(policies[0]).not.toBe(policies[1]);
    expect(policies[1]).toContain(teamRecordVectorIndexName("ws-b"));
    expect(policies[1]).not.toContain(teamRecordVectorIndexName("ws-a"));
  });
  it("fails with a fixed message and no AWS text when STS fails or returns no credentials", async () => {
    const failing = createStsAssumePort({ send: async () => { throw new Error("AccessDenied: arn:secret"); } } as never);
    await expect(failing.assumeRole({ roleArn: "r", sessionName: "s", policy: "{}", durationSeconds: 3600 })).rejects.toThrow("team-record: could not assume the vector data role");
    const empty = createStsAssumePort({ send: async () => ({}) } as never);
    await expect(empty.assumeRole({ roleArn: "r", sessionName: "s", policy: "{}", durationSeconds: 3600 })).rejects.toThrow(/no credentials/);
  });
});
