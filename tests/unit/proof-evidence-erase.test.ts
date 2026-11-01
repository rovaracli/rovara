// Proof and evidence (wire-proof fix round 1): the pack carries the evidence-std retention tag like the tails, and erasing a person, archiving a project or closing a company deletes everything the evidence
// path stored for that scope (the pack and the tails), and nothing outside it.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_PROJECT_INDEX, orgProjectCatalogPk, workspaceProjectIndexValue, type OrgId } from "../../packages/contracts/src/index.js";
import { createEvidenceErase, evidencePrefixesOf } from "../../packages/broker/src/rovara-code/evidence-erase.js";
import { evidencePackKey, keepEvidence } from "../../packages/broker/src/rovara-code/evidence-keep.js";
import { clearArchivedProjectLearning } from "../../packages/broker/src/aws/developer-routes/project-archive-setup.js";
import { clearOrgData } from "../../packages/broker/src/aws/developer-routes/organization.js";
import { personErasureStep } from "../../packages/broker/src/aws/broker/evidence-wiring.js";

const ORG = "org-a" as OrgId;
const OTHER_ORG = "org-b" as OrgId;
const DEV = "d".repeat(64);
const DIGEST = "c".repeat(64);
const key = (owner: string, ws: string, kind: "evidence-pack" | "evidence", task: string, name = "x.json") => `private/${owner}/${ws}/${kind}/${task}/${name}`;

/** An in-memory bucket with the calls the store and the erase make, and the tags it was given. */
function bucket(initial: string[] = []) {
  const objects = new Map<string, { body: string; tagging?: string | undefined }>(initial.map((k) => [k, { body: "x" }]));
  const failDeletes = { on: false };
  const s3 = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, { body: String(command.input.Body as string), tagging: command.input.Tagging }); return {}; }
    if (command instanceof GetObjectCommand) { const found = objects.get(command.input.Key!); if (found === undefined) throw new Error("NoSuchKey"); return { Body: { transformToString: async () => found.body } }; }
    if (command instanceof ListObjectsV2Command) return { Contents: [...objects.keys()].filter((k) => k.startsWith(command.input.Prefix!)).slice(0, 2).map((Key) => ({ Key })) };
    if (command instanceof DeleteObjectsCommand) {
      if (failDeletes.on) return { Errors: [{ Key: "x" }] };
      for (const { Key } of command.input.Delete!.Objects!) objects.delete(Key!);
      return {};
    }
    throw new Error("unexpected command");
  } } as unknown as S3Client;
  return { objects, s3, failDeletes };
}

/** A table with a person's task rows, task records, workspaces of two projects and the project catalog. */
function table() {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      if (command.input.IndexName === WORKSPACE_PROJECT_INDEX.name) {
        const rows: Record<string, Array<Record<string, unknown>>> = {
          [workspaceProjectIndexValue(ORG, "web")]: [{ id: "ws1", ownerKey: "own1" }, { id: "ws2", ownerKey: "own2" }],
          [workspaceProjectIndexValue(ORG, "api")]: [{ id: "ws3", ownerKey: "own3" }],
          [workspaceProjectIndexValue(OTHER_ORG, "web")]: [{ id: "wsx", ownerKey: "ownx" }],
        };
        return { Items: rows[values[":project"]!] ?? [] };
      }
      if (values[":pk"] === orgProjectCatalogPk(ORG)) return { Items: [{ sk: "PROJECT#web" }, { sk: "PROJECT#api" }] };
      if (values[":pk"] === `DEVELOPER#${DEV}`) return { Items: [{ taskId: "t1", orgId: ORG }, { taskId: "t9", orgId: OTHER_ORG }] };
      return { Items: [] };
    }
    if (command instanceof GetCommand) {
      const tasks: Record<string, Record<string, unknown>> = { "DEVTASK#t1": { ownerKey: "own1", workspaceId: "ws1", orgId: ORG }, "DEVTASK#t9": { ownerKey: "ownx", workspaceId: "wsx", orgId: OTHER_ORG } };
      return { Item: tasks[String(command.input.Key!.pk)] };
    }
    throw new Error("unexpected command");
  });
  return { documentClient: { send }, tableName: "State" };
}

const populate = () => bucket([
  key("own1", "ws1", "evidence-pack", "t1", `${DIGEST}.json`), key("own1", "ws1", "evidence", "t1", "a".repeat(64)), key("own1", "ws1", "evidence-pack", "t2", `${DIGEST}.json`),
  key("own2", "ws2", "evidence-pack", "t5", `${DIGEST}.json`), key("own3", "ws3", "evidence", "t6", "b".repeat(64)),
  key("ownx", "wsx", "evidence-pack", "t9", `${DIGEST}.json`),
  "private/own1/ws1/op-1/evidence-raw.json", "private/own1/ws1/plan-documents/plan.md",
]);
const erase = (b: ReturnType<typeof bucket>, over: Record<string, unknown> = {}) => createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...table(), ...over });

describe("the pack's retention", () => {
  it("is tagged evidence-std like the output tails, so it expires with them", async () => {
    const b = bucket();
    const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [{ name: "t", status: "passed" }], newTests: [] } }] });
    const prefix = "private/own1/ws1/op-1/";
    const actions = { artifacts: async () => [{ name: "evidence-raw.json", objectKey: `${prefix}evidence-raw.json` }], readArtifact: async (k: string) => (k.startsWith(prefix) ? raw : b.objects.get(k)?.body ?? "") };
    const entry = { id: "readiness:0", label: "pytest", source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 5, exitCode: 0 };
    expect(await keepEvidence({ actions, store: { s3: b.s3, artifactBucketName: "bucket" } }, { task: { ownerKey: "own1", workspaceId: "ws1", taskId: "t1" }, operationId: "op-1", candidateDigest: DIGEST, checks: [entry] })).toMatchObject({ kept: true });
    expect(b.objects.get(evidencePackKey({ ownerKey: "own1", workspaceId: "ws1", taskId: "t1" }, DIGEST))?.tagging).toBe("rovara-retention=evidence-std");
  });
});

describe("a person's erase", () => {
  it("deletes the pack and the tails of the tasks the person created or owns, in their org, and nothing else", async () => {
    const b = populate();
    await erase(b).person(ORG, DEV);
    expect([...b.objects.keys()].sort()).toEqual([
      key("own1", "ws1", "evidence-pack", "t2", `${DIGEST}.json`), key("own2", "ws2", "evidence-pack", "t5", `${DIGEST}.json`), key("own3", "ws3", "evidence", "t6", "b".repeat(64)),
      key("ownx", "wsx", "evidence-pack", "t9", `${DIGEST}.json`), "private/own1/ws1/op-1/evidence-raw.json", "private/own1/ws1/plan-documents/plan.md",
    ].sort());
  });

  it("is part of the person-erase step after the Team record's, and a failure in either throws so the request is repeated", async () => {
    const order: string[] = [];
    const teamRecord = { erase: { person: async () => { order.push("record"); } } };
    await personErasureStep(teamRecord, { person: async () => { order.push("evidence"); } })(ORG, DEV);
    expect(order).toEqual(["record", "evidence"]);
    await personErasureStep(undefined, { person: async () => { order.push("evidence-only"); } })(ORG, DEV);
    expect(order.at(-1)).toBe("evidence-only");
    await expect(personErasureStep(teamRecord, { person: async () => { throw new Error("unfinished"); } })(ORG, DEV)).rejects.toThrow("unfinished");
  });
});

describe("a project's archive", () => {
  it("deletes the pack and the tails of every workspace of that project only", async () => {
    const b = populate();
    await erase(b).project(ORG, "web");
    expect([...b.objects.keys()].filter((k) => /\/evidence(-pack)?\//u.test(k))).toEqual([key("own3", "ws3", "evidence", "t6", "b".repeat(64)), key("ownx", "wsx", "evidence-pack", "t9", `${DIGEST}.json`)]);
    // The workspace's other objects are not evidence: they stay.
    expect(b.objects.has("private/own1/ws1/op-1/evidence-raw.json")).toBe(true);
    expect(b.objects.has("private/own1/ws1/plan-documents/plan.md")).toBe(true);
  });

  it("through the archive path: runs, and a failure never fails the archive", async () => {
    const calls: unknown[][] = [];
    const base = { documentClient: { send: vi.fn(async () => ({})) }, tableName: "State", now: () => 0 };
    await clearArchivedProjectLearning({ ...base, evidenceErase: { project: async (...a: unknown[]) => { calls.push(a); }, workspace: async () => undefined } }, ORG, "web");
    expect(calls).toEqual([[ORG, "web"]]);
    await expect(clearArchivedProjectLearning({ ...base, evidenceErase: { project: async () => { throw new Error("storage detail"); }, workspace: async () => undefined } }, ORG, "web")).resolves.toBeUndefined();
  });
});

describe("a company's close", () => {
  it("deletes the evidence of every project of the company, and no other company's", async () => {
    const b = populate();
    await erase(b).workspace(ORG);
    expect([...b.objects.keys()].filter((k) => /\/evidence(-pack)?\//u.test(k))).toEqual([key("ownx", "wsx", "evidence-pack", "t9", `${DIGEST}.json`)]);
  });

  it("is a step of the close: after the learning data and the record, and its failure fails the close so it is repeated", async () => {
    const order: string[] = [];
    const learning = { documentClient: { send: vi.fn(async () => ({ Items: [] })) }, tableName: "State", now: () => 0 };
    const deps = { ...learning, teamRecord: { erase: { workspace: async () => { order.push("record"); } } }, evidenceErase: { workspace: async () => { order.push("evidence"); }, project: async () => undefined } };
    await clearOrgData(deps as never)(ORG);
    expect(order).toEqual(["record", "evidence"]);
    await expect(clearOrgData({ ...deps, evidenceErase: { workspace: async () => { throw new Error("unfinished"); }, project: async () => undefined } } as never)(ORG)).rejects.toThrow("unfinished");
  });
});

describe("what the erase refuses and reports", () => {
  it("never widens a prefix: an owner or workspace id that is not a plain id gives no prefixes", () => {
    expect(evidencePrefixesOf({ ownerKey: "own1", workspaceId: "ws1" })).toEqual(["private/own1/ws1/evidence-pack/", "private/own1/ws1/evidence/"]);
    for (const bad of ["", "../x", "a/b", "a b", "a*"]) {
      expect(evidencePrefixesOf({ ownerKey: bad, workspaceId: "ws1" }), JSON.stringify(bad)).toBeUndefined();
      expect(evidencePrefixesOf({ ownerKey: "own1", workspaceId: bad })).toBeUndefined();
      expect(evidencePrefixesOf({ ownerKey: "own1", workspaceId: "ws1", taskId: bad })).toBeUndefined();
    }
  });

  it("a record with a path-like workspace id deletes nothing", async () => {
    const b = populate();
    const doc = { send: vi.fn(async (command: unknown) => (command instanceof QueryCommand ? { Items: [{ id: "../ws1", ownerKey: "own1" }] } : { Item: undefined })) };
    await erase(b, { documentClient: doc }).project(ORG, "web");
    expect(b.objects.size).toBe(8);
  });

  it("a store that reports a failed delete, or runs out of time, is unfinished (it throws, nothing is claimed)", async () => {
    const b = populate();
    b.failDeletes.on = true;
    await expect(erase(b).project(ORG, "web")).rejects.toMatchObject({ name: "EvidenceEraseUnfinished" });
    b.failDeletes.on = false;
    let clock = 0;
    await expect(erase(b, { now: () => (clock += 30_000), maxMs: 20_000 }).project(ORG, "web")).rejects.toMatchObject({ name: "EvidenceEraseUnfinished" });
  });
});
