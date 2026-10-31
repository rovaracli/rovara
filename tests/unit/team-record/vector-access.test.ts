import { teamRecordVectorIndexName } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { S3VectorsIndex, type S3VectorsPort } from "../../../packages/broker/src/team-record/s3-vectors-index.js";
import { WorkspaceVectorPorts, workspaceVectorSessionPolicy, type SessionPolicyInput } from "../../../packages/broker/src/team-record/vector-access.js";

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
