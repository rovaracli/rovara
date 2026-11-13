// Convergence S0 ROWS: the Cloud readers that ask for one record of a core task, run for real over a light fake table: getArtifact (D17), pageEvents (D18) and the
// automatic-fix usage read (D18, the cost view). Each reads Cloud's shape only, the core's shape only, both (Cloud's wins), and neither.
import { describe, expect, it } from "vitest";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { getArtifact, pageEvents } from "../../packages/broker/src/aws/broker/records.js";
import { autofixOperationUsage } from "../../packages/broker/src/aws/broker/dispatch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const W = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const OWNER = "owner-key-0123456789abcdef";
const NOW = "2026-11-12T10:00:00.000Z";

function world() {
  const db = new FakeDynamoDb();
  db.set({ pk: `WORKSPACE#${W}`, sk: "META", entityType: "WORKSPACE", id: W, ownerKey: OWNER, orgId: ORG, projectName: "payments", projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY", activeOperationId: null, fence: 1, createdAt: NOW, updatedAt: NOW });
  db.set({ pk: `WORKSPACE#${W}`, sk: `OPERATION#${OP}`, entityType: "OPERATION", id: OP, workspaceId: W, orgId: ORG, kind: "task", requestId: "33333333-3333-4333-8333-333333333333", payloadHash: "a".repeat(64), status: "SUCCEEDED", fence: 1, createdAt: NOW, updatedAt: NOW });
  db.set({ ...orgMemberKey(ORG, OWNER), entityType: "ORG_MEMBER", role: "owner", joinedAt: NOW });
  const objects = new Map<string, string>();
  const dependencies = {
    documentClient: db, tableName: "state", artifactBucketName: "bucket", cloud: true,
    s3: { send: async (command: { input: { Key: string } }) => { const body = objects.get(command.input.Key); if (body === undefined) throw new Error("no such object"); return { Body: { transformToString: async () => body } }; } },
  };
  const identity = { issuer: "i", subject: "s", ownerKey: OWNER, orgId: ORG, isAdministrator: false, claims: {} };
  return { db, objects, dependencies: dependencies as never, identity: identity as never };
}

const cloudArtifact = { pk: `WORKSPACE#${W}`, sk: "ARTIFACT#art-1", entityType: "ARTIFACT", id: "art-1", workspaceId: W, operationId: OP, ownerKey: OWNER, name: "plan.md", mediaType: "text/markdown", objectKey: "cloud/art-1", size: 5, createdAt: NOW };
const coreArtifact = { pk: `WORKSPACE#${W}`, sk: `ARTIFACT#${OP}#plan.md`, entityType: "ARTIFACT", id: "art-1", workspaceId: W, operationId: OP, name: "plan.md", mediaType: "text/markdown", objectKey: "core/art-1", sha256: "f".repeat(64), bytes: 4, createdAt: NOW };

describe("getArtifact reads a Cloud task's artifact and a core task's", () => {
  it("Cloud shape only", async () => {
    const w = world(); w.db.set(cloudArtifact); w.objects.set("cloud/art-1", "cloud");
    expect(await getArtifact(w.dependencies, w.identity, W, "art-1")).toMatchObject({ id: "art-1", name: "plan.md", operationId: OP, content: "cloud" });
  });

  it("core shape only: found by the id on its row, owned through the caller's own workspace", async () => {
    const w = world(); w.db.set(coreArtifact); w.objects.set("core/art-1", "core");
    expect(await getArtifact(w.dependencies, w.identity, W, "art-1")).toMatchObject({ id: "art-1", name: "plan.md", operationId: OP, mediaType: "text/markdown", content: "core" });
  });

  it("both present: Cloud's wins", async () => {
    const w = world(); w.db.set(cloudArtifact); w.db.set(coreArtifact); w.objects.set("cloud/art-1", "cloud"); w.objects.set("core/art-1", "core");
    expect((await getArtifact(w.dependencies, w.identity, W, "art-1")).content).toBe("cloud");
  });

  it("neither: not found", async () => {
    const w = world();
    await expect(getArtifact(w.dependencies, w.identity, W, "art-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a core artifact of a workspace the caller does not own is never read", async () => {
    const w = world(); w.db.set(coreArtifact); w.objects.set("core/art-1", "core");
    await expect(getArtifact(w.dependencies, { ...(w.identity as object), ownerKey: "someone-else-0123456789" } as never, W, "art-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("pageEvents reads a Cloud operation's events and a core operation's", () => {
  const cloud = (n: number) => ({ pk: `OPERATION#${OP}`, sk: `EVENT#${String(n).padStart(12, "0")}`, entityType: "EVENT", workspaceId: W, operationId: OP, sequence: n, type: "progress", timestamp: NOW, payload: { message: `cloud ${n}` } });
  const core = (n: number) => ({ pk: `WORKSPACE#${W}`, sk: `EVENT#${OP}#${String(n).padStart(10, "0")}`, entityType: "OPERATION_EVENT", operationId: OP, sequence: n, type: "progress", timestamp: NOW, payload: { message: `core ${n}` } });
  const messages = (page: { events: Array<{ payload: unknown }> }) => page.events.map((event) => (event.payload as { message: string }).message);

  it("Cloud shape only", async () => {
    const w = world(); [1, 2].forEach((n) => w.db.set(cloud(n)));
    expect(messages(await pageEvents(w.dependencies, w.identity, W, OP, { limit: 10 }))).toEqual(["cloud 1", "cloud 2"]);
  });

  it("core shape only, paged by Cloud's own cursor", async () => {
    const w = world(); [1, 2, 3].forEach((n) => w.db.set(core(n)));
    const first = await pageEvents(w.dependencies, w.identity, W, OP, { limit: 2 });
    expect(messages(first)).toEqual(["core 1", "core 2"]);
    expect(first.cursor).toBeDefined();
    const second = await pageEvents(w.dependencies, w.identity, W, OP, { limit: 2, cursor: first.cursor as string });
    expect(messages(second)).toContain("core 3");
    expect(second.cursor).toBeUndefined();
  });

  it("both present: Cloud's partition wins and the core's rows are not mixed in", async () => {
    const w = world(); w.db.set(cloud(1)); [1, 2].forEach((n) => w.db.set(core(n)));
    expect(messages(await pageEvents(w.dependencies, w.identity, W, OP, { limit: 10 }))).toEqual(["cloud 1"]);
  });

  it("neither: an empty page", async () => {
    const w = world();
    expect(await pageEvents(w.dependencies, w.identity, W, OP, { limit: 10 })).toEqual({ events: [] });
  });
});

describe("the automatic-fix usage read (cost view) reads a Cloud operation's usage and a core operation's", () => {
  const usage = (pk: string, sk: string, entityType: string, cost: number | null) => ({ pk, sk, entityType, operationId: OP, sequence: 1, type: "usage", timestamp: NOW, payload: { costUsd: cost } });
  const cloud = (n: number, cost: number | null) => usage(`OPERATION#${OP}`, `EVENT#${String(n).padStart(12, "0")}`, "EVENT", cost);
  const core = (n: number, cost: number | null) => usage(`WORKSPACE#${W}`, `EVENT#${OP}#${String(n).padStart(10, "0")}`, "OPERATION_EVENT", cost);
  const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" }) as never;

  it("Cloud shape only", async () => {
    const db = new FakeDynamoDb(); db.set(cloud(1, 0.5)); db.set(cloud(2, 0.25));
    expect(await autofixOperationUsage(deps(db), OP, W)).toEqual({ total: 0.75, records: 2 });
  });

  it("core shape only: summed from the workspace's rows, an unpriced model counted as one more round", async () => {
    const db = new FakeDynamoDb(); db.set(core(1, 0.5)); db.set(core(2, null));
    expect(await autofixOperationUsage(deps(db), OP, W)).toEqual({ total: 3.5, records: 2 });
  });

  it("both present: Cloud's wins, the core's rows are not added", async () => {
    const db = new FakeDynamoDb(); db.set(cloud(1, 0.5)); db.set(core(1, 9));
    expect(await autofixOperationUsage(deps(db), OP, W)).toEqual({ total: 0.5, records: 1 });
  });

  it("neither: no records, as before", async () => {
    expect(await autofixOperationUsage(deps(new FakeDynamoDb()), OP, W)).toEqual({ total: 0, records: 0 });
  });

  it("without a workspace the core's rows are not looked for (a caller that does not know it reads as before)", async () => {
    const db = new FakeDynamoDb(); db.set(core(1, 0.5));
    expect(await autofixOperationUsage(deps(db), OP)).toEqual({ total: 0, records: 0 });
  });

  it("a core usage record that cannot be read makes the spend unknown, never zero", async () => {
    const db = new FakeDynamoDb(); db.set({ ...core(1, 0.5), payload: { costUsd: "lots" } });
    expect(await autofixOperationUsage(deps(db), OP, W)).toBeUndefined();
  });
});
