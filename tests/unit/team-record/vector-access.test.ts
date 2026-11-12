import { RETIRED_INDEX_TAG_KEYS, RETIRED_TEAM_RECORD_SPECS, TEAM_RECORD_EMBEDDER, retiredTeamRecordVectorIndexName, retiredTeamRecordVectorIndexNames, teamRecordVectorIndexName } from "@agentx/cloud-contracts";
import { describe, expect, it } from "vitest";
import { S3VectorsIndex, type S3VectorsPort } from "../../../packages/broker/src/team-record/s3-vectors-index.js";
import { WorkspaceVectorPorts, createAssume, createStsAssumePort, openWorkspaceIndex, workspaceVectorSessionPolicy, type SessionPolicyInput } from "../../../packages/broker/src/team-record/vector-access.js";

const base = { region: "us-west-2", account: "111122223333", bucket: "rovara-record-vectors" };
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

describe("session policy per workspace", () => {
  it("reaches the one index of one workspace, with no wildcard on the index and no bucket right; the only delete-index right is for that workspace's retired indexes (Titan and Qwen3)", () => {
    const policy = workspaceVectorSessionPolicy({ ...base, workspaceId: "ws-a" });
    const text = JSON.stringify(policy);
    expect(text).toContain(`bucket/rovara-record-vectors/index/${teamRecordVectorIndexName("ws-a")}"`);
    expect(text).not.toContain("index/*");
    expect(text).not.toContain(teamRecordVectorIndexName("ws-b"));
    for (const name of retiredTeamRecordVectorIndexNames("ws-b")) expect(text).not.toContain(name);
    expect(text).not.toMatch(/CreateIndex|DeleteVectorBucket|ListIndexes/);
    const deletes = policy.Statement.filter((statement) => JSON.stringify(statement.Action).includes("DeleteIndex"));
    expect(deletes).toEqual([{ Effect: "Allow", Action: ["s3vectors:DeleteIndex"], Resource: retiredTeamRecordVectorIndexNames("ws-a").map((name) => `arn:aws:s3vectors:us-west-2:111122223333:bucket/rovara-record-vectors/index/${name}`) }]);
    // the old names: the Titan-era one (no spec) and one per retired spec, Qwen3 (0b0a5b868995d4ee) among them; none is the current one
    const old = retiredTeamRecordVectorIndexNames("ws-a");
    expect(RETIRED_TEAM_RECORD_SPECS).toContain("0b0a5b868995d4ee");
    expect(old).toEqual([retiredTeamRecordVectorIndexName("ws-a"), teamRecordVectorIndexName("ws-a", "0b0a5b868995d4ee")]);
    expect(new Set([...old, teamRecordVectorIndexName("ws-a")]).size).toBe(old.length + 1);
    expect(RETIRED_TEAM_RECORD_SPECS).not.toContain(TEAM_RECORD_EMBEDDER.spec);
    expect(retiredTeamRecordVectorIndexName("ws-a")).not.toBe(teamRecordVectorIndexName("ws-a"));
    expect(text.length).toBeLessThan(2048);
    // even with index creation and a key the policy stays inside the 2,048 characters STS allows
    expect(JSON.stringify(workspaceVectorSessionPolicy({ ...base, workspaceId: "ws-a", allowCreateIndex: true, kmsKeyArn: KMS })).length).toBeLessThan(2048);
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
    // the session carries the tags the data role's rights name: the current index and one per retired index (Titan, then Qwen3)
    expect(RETIRED_INDEX_TAG_KEYS).toEqual(["rovara-retired-index", "rovara-retired-index-2"]);
    expect((sent[0] as { Tags?: Array<{ Key: string; Value: string }> }).Tags).toEqual([{ Key: "rovara-index", Value: teamRecordVectorIndexName("ws-a") }, ...retiredTeamRecordVectorIndexNames("ws-a").map((name, position) => ({ Key: RETIRED_INDEX_TAG_KEYS[position], Value: name }))]);
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

describe("retiring the index of the embedding generation before the current one (review H1)", () => {
  type Call = { op: string; indexName: string };
  const portWith = (state: { current: boolean; retired: boolean }, calls: Call[], fail?: string): S3VectorsPort => ({
    async getIndex({ indexName }: { indexName: string }) { calls.push({ op: "get", indexName }); if (!state.current) throw Object.assign(new Error("x"), { code: "NotFoundException" }); },
    async deleteIndex({ indexName }: { indexName: string }) {
      calls.push({ op: "delete", indexName });
      if (fail !== undefined) throw Object.assign(new Error("x"), { code: fail });
      if (!state.retired) throw Object.assign(new Error("x"), { code: "NotFoundException" });
      state.retired = false;
    },
  } as unknown as S3VectorsPort);
  const indexOver = (port: S3VectorsPort) => new S3VectorsIndex({ port, bucket: "rovara-record-vectors", workspaceId: "ws-a", dimension: 4, retry: { attempts: 1, baseDelayMs: 0, sleep: async () => undefined } });

  it("deletes the retired index once the current one exists, and says nothing is left the next time", async () => {
    const calls: Call[] = [];
    const state = { current: true, retired: true };
    const index = indexOver(portWith(state, calls));
    expect(await index.retireOldIndex()).toBe("deleted");
    expect(await index.retireOldIndex()).toBe("absent");
    expect(calls.filter((call) => call.op === "delete").map((call) => call.indexName)).toEqual([...retiredTeamRecordVectorIndexNames("ws-a"), ...retiredTeamRecordVectorIndexNames("ws-a")]);
    expect(calls.filter((call) => call.op === "get").every((call) => call.indexName === teamRecordVectorIndexName("ws-a"))).toBe(true);
  });
  /** A bucket that really holds indexes: getIndex and deleteIndex act on a set of names. */
  const bucketWith = (names: string[], failOn: string[] = []) => {
    const indexes = new Set(names);
    const port = {
      async getIndex({ indexName }: { indexName: string }) { if (!indexes.has(indexName)) throw Object.assign(new Error("x"), { code: "NotFoundException" }); },
      async deleteIndex({ indexName }: { indexName: string }) {
        if (failOn.includes(indexName)) throw Object.assign(new Error("x"), { code: "AccessDeniedException" });
        if (!indexes.delete(indexName)) throw Object.assign(new Error("x"), { code: "NotFoundException" });
      },
    } as unknown as S3VectorsPort;
    return { indexes, port };
  };
  const [TITAN, QWEN] = retiredTeamRecordVectorIndexNames("ws-a") as [string, string];

  it("DECISIONS 140: a workspace with a leftover Qwen3 index (1,024-d, its spec's name) has it retired, and no index but the current one remains", async () => {
    const bucket = bucketWith([teamRecordVectorIndexName("ws-a"), QWEN, teamRecordVectorIndexName("ws-b"), retiredTeamRecordVectorIndexNames("ws-b")[1]!]);
    expect(await indexOver(bucket.port).retireOldIndex()).toBe("deleted");
    // ws-a keeps only its current index; ws-b's indexes are not this index's business
    expect([...bucket.indexes].sort()).toEqual([teamRecordVectorIndexName("ws-a"), teamRecordVectorIndexName("ws-b"), retiredTeamRecordVectorIndexNames("ws-b")[1]!].sort());
    expect(await indexOver(bucket.port).retireOldIndex()).toBe("absent");
  });
  it("retires the Titan-era and the Qwen3 index together, leaving only the current one", async () => {
    const bucket = bucketWith([teamRecordVectorIndexName("ws-a"), TITAN, QWEN]);
    expect(await indexOver(bucket.port).retireOldIndex()).toBe("deleted");
    expect([...bucket.indexes]).toEqual([teamRecordVectorIndexName("ws-a")]);
  });
  it("a refused delete of one old index does not keep the other alive, and still fails the retire (an erase stays blocked until every old index is gone)", async () => {
    const bucket = bucketWith([teamRecordVectorIndexName("ws-a"), TITAN, QWEN], [TITAN]);
    await expect(indexOver(bucket.port).retireOldIndex()).rejects.toMatchObject({ code: "AccessDeniedException" });
    expect([...bucket.indexes].sort()).toEqual([teamRecordVectorIndexName("ws-a"), TITAN].sort());
  });
  it("deletes nothing while the current index does not exist yet", async () => {
    const calls: Call[] = [];
    expect(await indexOver(portWith({ current: false, retired: true }, calls)).retireOldIndex()).toBe("current_missing");
    expect(calls.some((call) => call.op === "delete")).toBe(false);
  });
  it("lets any other failure through, so the caller keeps treating the old index as present", async () => {
    await expect(indexOver(portWith({ current: true, retired: true }, [], "AccessDeniedException")).retireOldIndex()).rejects.toMatchObject({ code: "AccessDeniedException" });
  });
});
