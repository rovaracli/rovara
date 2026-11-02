// Proof and evidence (wire-proof fix round 1): the pack carries the evidence-std retention tag like the tails, and erasing a person, archiving a project or closing a company deletes everything the evidence
// path stored for that scope (the pack and the tails), and nothing outside it.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_PROJECT_INDEX, orgProjectCatalogPk, workspaceProjectIndexValue, type OrgId } from "../../packages/contracts/src/index.js";
import { createEvidenceErase, evidencePrefixesOf, evidenceStoredIn, markEvidenceStored, resumeEvidenceErase } from "../../packages/broker/src/rovara-code/evidence-erase.js";
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

/**
 * A table with a person's task rows (`extraTasks` more, each with a task record and no evidence), task records, workspaces of two projects and the project catalog, an item store for the marker and the
 * pending records, and the pagination (`Limit`, `ExclusiveStartKey`) the walk uses. `marked: false` is an install that never kept evidence.
 */
function table(options: { marked?: boolean; extraTasks?: number; failGets?: { markerTimes: number; pendingTimes: number } } = {}) {
  const fails = { marker: options.failGets?.markerTimes ?? 0, pending: options.failGets?.pendingTimes ?? 0 };
  const items = new Map<string, Record<string, unknown>>();
  if (options.marked !== false) items.set(`EVIDENCE_STORED#${ORG}|META`, { pk: `EVIDENCE_STORED#${ORG}`, sk: "META" });
  const extra = Array.from({ length: options.extraTasks ?? 0 }, (_, index) => ({ taskId: `x${String(index)}`, orgId: ORG }));
  const personRows = [{ taskId: "t1", orgId: ORG }, { taskId: "t9", orgId: OTHER_ORG }, ...extra];
  const calls = { queries: [] as Array<Record<string, unknown>>, taskGets: 0 };
  const page = <T>(rows: T[], input: { Limit?: number; ExclusiveStartKey?: { i: number } }) => {
    const from = input.ExclusiveStartKey?.i ?? 0;
    const to = input.Limit === undefined ? rows.length : Math.min(rows.length, from + input.Limit);
    return { Items: rows.slice(from, to), ...(to < rows.length ? { LastEvaluatedKey: { i: to } } : {}) };
  };
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof PutCommand) {
      const at = `${String(command.input.Item!.pk)}|${String(command.input.Item!.sk)}`;
      if (String(command.input.ConditionExpression ?? "").includes("attribute_not_exists") && items.has(at)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      items.set(at, command.input.Item!);
      return {};
    }
    if (command instanceof DeleteCommand) { items.delete(`${String(command.input.Key!.pk)}|${String(command.input.Key!.sk)}`); return {}; }
    if (command instanceof QueryCommand) {
      calls.queries.push(command.input);
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      const input = command.input as unknown as { Limit?: number; ExclusiveStartKey?: { i: number } };
      if (command.input.IndexName === WORKSPACE_PROJECT_INDEX.name) {
        const rows: Record<string, Array<Record<string, unknown>>> = {
          [workspaceProjectIndexValue(ORG, "web")]: [{ id: "ws1", ownerKey: "own1" }, { id: "ws2", ownerKey: "own2" }],
          [workspaceProjectIndexValue(ORG, "api")]: [{ id: "ws3", ownerKey: "own3" }],
          [workspaceProjectIndexValue(OTHER_ORG, "web")]: [{ id: "wsx", ownerKey: "ownx" }],
        };
        return page(rows[values[":project"]!] ?? [], input);
      }
      if (values[":pk"] === orgProjectCatalogPk(ORG)) return { Items: [{ sk: "PROJECT#web" }, { sk: "PROJECT#api" }] };
      if (values[":pk"] === `DEVELOPER#${DEV}`) return page(personRows, input);
      if (values[":pk"] === "EVIDENCE_ERASE_PENDING") return { Items: [...items.values()].filter((item) => item.pk === "EVIDENCE_ERASE_PENDING") };
      return { Items: [] };
    }
    if (command instanceof GetCommand) {
      const key = command.input.Key as { pk: string; sk: string };
      if (key.pk.startsWith("EVIDENCE_STORED") && fails.marker > 0) { fails.marker -= 1; throw new Error("table unavailable"); }
      if (key.pk === "EVIDENCE_ERASE_PENDING" && fails.pending > 0) { fails.pending -= 1; throw new Error("table unavailable"); }
      if (key.pk.startsWith("EVIDENCE_")) return { Item: items.get(`${key.pk}|${key.sk}`) };
      calls.taskGets += 1;
      const tasks: Record<string, Record<string, unknown>> = { "DEVTASK#t1": { ownerKey: "own1", workspaceId: "ws1", orgId: ORG }, "DEVTASK#t9": { ownerKey: "ownx", workspaceId: "wsx", orgId: OTHER_ORG } };
      for (const row of extra) tasks[`DEVTASK#${row.taskId}`] = { ownerKey: `ownx${row.taskId}`, workspaceId: `wsx${row.taskId}`, orgId: ORG };
      return { Item: tasks[key.pk] };
    }
    throw new Error("unexpected command");
  });
  return { documentClient: { send }, tableName: "State", items, calls };
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
    expect(await keepEvidence({ actions, store: { s3: b.s3, artifactBucketName: "bucket" }, markStored: async () => undefined }, { orgId: ORG, task: { ownerKey: "own1", workspaceId: "ws1", taskId: "t1" }, operationId: "op-1", candidateDigest: DIGEST, checks: [entry] })).toMatchObject({ kept: true });
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

  it("is part of the close's learning step, after the learning data (the Team record is its own close step), and an unfinished pass throws", async () => {
    const order: string[] = [];
    const learning = { documentClient: { send: vi.fn(async () => ({ Items: [] })) }, tableName: "State", now: () => 0 };
    const deps = { ...learning, teamRecord: { erase: { workspace: async () => { order.push("record"); } } }, evidenceErase: { workspace: async () => { order.push("evidence"); }, project: async () => undefined } };
    await clearOrgData(deps)(ORG);
    expect(order).toEqual(["evidence"]);
    await expect(clearOrgData({ ...deps, evidenceErase: { workspace: async () => { throw new Error("unfinished"); }, project: async () => undefined } })(ORG)).rejects.toThrow("unfinished");
  });
});

describe("the company close's evidence step does not depend on the learning step", () => {
  // PRF-3 (recheck2 gap 1): the close swallows what this step throws; when the learning walk threw, the evidence step never ran and no pending record existed.
  it("runs the evidence erase when the learning walk throws, and still reports the learning failure afterwards", async () => {
    const order: string[] = [];
    const deps = { documentClient: { send: vi.fn(async () => { throw new Error("learning table down"); }) }, tableName: "State", now: () => 0, evidenceErase: { workspace: async () => { order.push("evidence"); }, project: async () => undefined } };
    await expect(clearOrgData(deps)(ORG)).rejects.toThrow("learning table down");
    expect(order).toEqual(["evidence"]);
  });

  it("an evidence failure after a clean learning walk still throws (the close logs it; the pending record is the evidence erase's own)", async () => {
    const deps = { documentClient: { send: vi.fn(async () => ({ Items: [] })) }, tableName: "State", now: () => 0, evidenceErase: { workspace: async () => { throw new Error("unfinished"); }, project: async () => undefined } };
    await expect(clearOrgData(deps)(ORG)).rejects.toThrow("unfinished");
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
    const doc = { send: vi.fn(async (command: unknown) => (command instanceof QueryCommand ? { Items: [{ id: "../ws1", ownerKey: "own1" }] } : command instanceof GetCommand ? { Item: { marked: true } } : {})) };
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

describe("an install that never kept evidence, and a walk that continues", () => {
  const PERSON_TASKS = 500;

  it("a person with 500 tasks and no evidence is erased on the first pass: one read, no task read, no list, no 'send again'", async () => {
    const t = table({ marked: false, extraTasks: PERSON_TASKS });
    const b = populate();
    const sent = vi.spyOn(b.s3, "send");
    await expect(createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }).person(ORG, DEV)).resolves.toBeUndefined();
    expect(t.calls.taskGets).toBe(0);
    expect(t.calls.queries).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    // The same for a project and a company.
    await createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }).project(ORG, "web");
    await createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }).workspace(ORG);
    expect(sent).not.toHaveBeenCalled();
  });

  it("the first pack an org keeps marks the org, and the marker is there before anything is stored; an org with the marker is walked", async () => {
    const t = table({ marked: false });
    expect(await evidenceStoredIn(t, ORG)).toBe(false);
    await markEvidenceStored(t, ORG);
    expect(await evidenceStoredIn(t, ORG)).toBe(true);
    await markEvidenceStored(t, ORG);
    expect(await evidenceStoredIn(t, "org-z")).toBe(false);
  });

  it("with evidence kept, a person with 500 tasks is walked a page at a time, and a pass that runs out of time is continued from its cursor, not from the start", async () => {
    const t = table({ extraTasks: PERSON_TASKS });
    const b = populate();
    let clock = 0;
    // Each S3 call moves the clock; the pass is allowed 5 s, so it stops after a few pages.
    const timed = { ...b.s3, send: async (command: unknown) => { clock += 20; return b.s3.send(command as never); } } as unknown as S3Client;
    const make = (maxMs: number) => createEvidenceErase({ s3: timed, artifactBucketName: "bucket", ...t, now: () => clock, maxMs });
    await expect(make(5_000).person(ORG, DEV)).rejects.toMatchObject({ name: "EvidenceEraseUnfinished" });
    const pending = [...t.items.values()].filter((item) => item.pk === "EVIDENCE_ERASE_PENDING");
    expect(pending).toHaveLength(1);
    const cursor = (pending[0]!.cursor as { i: number }).i;
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(PERSON_TASKS);
    // The next call starts at the saved cursor: no query starts before it, and it finishes.
    t.calls.queries.length = 0;
    await make(60_000).person(ORG, DEV);
    const starts = t.calls.queries.map((query) => (query.ExclusiveStartKey as { i: number } | undefined)?.i ?? 0);
    expect(Math.min(...starts)).toBe(cursor);
    expect([...t.items.values()].filter((item) => item.pk === "EVIDENCE_ERASE_PENDING")).toEqual([]);
    // And the person's own evidence is gone.
    expect([...b.objects.keys()].some((k) => k.startsWith("private/own1/ws1/evidence-pack/t1/"))).toBe(false);
  });
});

describe("the cursor is saved between pages", () => {
  it("a pass that dies in the middle (the store errors on a later page) has saved where it was, so the next one does not start over", async () => {
    const t = table({ extraTasks: 200 });
    const b = populate();
    let calls = 0;
    const dying = { send: async (command: unknown) => { calls += 1; if (calls > 400) throw new Error("store down"); return b.s3.send(command as never); } } as unknown as S3Client;
    await expect(createEvidenceErase({ s3: dying, artifactBucketName: "bucket", ...t }).person(ORG, DEV)).rejects.toThrow("store down");
    const pending = [...t.items.values()].filter((item) => item.pk === "EVIDENCE_ERASE_PENDING");
    expect((pending[0]?.cursor as { i: number } | undefined)?.i).toBeGreaterThan(0);
    // The next call goes on from there and finishes.
    t.calls.queries.length = 0;
    await createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }).person(ORG, DEV);
    expect(Math.min(...t.calls.queries.map((query) => (query.ExclusiveStartKey as { i: number } | undefined)?.i ?? 0))).toBe((pending[0]!.cursor as { i: number }).i);
  });
});

describe("a close or an archive that does not finish is not left behind", () => {
  /** An erase whose clock jumps with every store call, so a pass runs out of time after a couple of calls; `resumer` has all the time it needs. */
  function interrupted(t: ReturnType<typeof table>, b: ReturnType<typeof bucket>) {
    let clock = 0;
    const slow = { ...b.s3, send: async (command: unknown) => { clock += 60; return b.s3.send(command as never); } } as unknown as S3Client;
    const ports = (now: () => number, maxMs: number) => ({ s3: slow, artifactBucketName: "bucket", ...t, now, maxMs }) as never;
    return { slow: createEvidenceErase(ports(() => clock, 100)), resumer: ports(() => 0, 60_000), resumeErase: createEvidenceErase(ports(() => 0, 60_000)) };
  }
  const pendingOf = (t: ReturnType<typeof table>) => [...t.items.values()].filter((item) => item.pk === "EVIDENCE_ERASE_PENDING");
  const evidenceLeft = (b: ReturnType<typeof bucket>) => [...b.objects.keys()].filter((k) => /\/evidence(-pack)?\//u.test(k) && !k.startsWith("private/ownx/"));

  it("an interrupted company close: the close swallows the unfinished erase, a pending record is left, and the scheduled run finishes it", async () => {
    const t = table();
    const b = populate();
    const w = interrupted(t, b);
    // The close's step: the way OrgStore.closeOrg runs it (it catches and logs what the step throws).
    await clearOrgData({ documentClient: { send: vi.fn(async () => ({ Items: [] })) }, tableName: "State", now: () => 0, evidenceErase: w.slow })(ORG).catch(() => undefined);
    expect(evidenceLeft(b).length).toBeGreaterThan(0);
    expect(pendingOf(t)).toHaveLength(1);
    expect(pendingOf(t)[0]).toMatchObject({ orgId: ORG, kind: "workspace" });
    const report = await resumeEvidenceErase(w.resumer, w.resumeErase, { millis: 60_000 });
    expect(report).toEqual({ pending: 1, finished: 1 });
    expect(evidenceLeft(b)).toEqual([]);
    expect(pendingOf(t)).toEqual([]);
    // Another company's evidence was never touched.
    expect(b.objects.has(key("ownx", "wsx", "evidence-pack", "t9", `${DIGEST}.json`))).toBe(true);
  });

  it("an interrupted project archive: the archive path logs and goes on, a pending record is left, and the scheduled run finishes it", async () => {
    const t = table();
    const b = populate();
    const w = interrupted(t, b);
    await expect(clearArchivedProjectLearning({ documentClient: { send: vi.fn(async () => ({})) }, tableName: "State", now: () => 0, evidenceErase: w.slow }, ORG, "web")).resolves.toBeUndefined();
    expect(pendingOf(t)).toHaveLength(1);
    expect(pendingOf(t)[0]).toMatchObject({ orgId: ORG, kind: "project", scopeKey: "web" });
    await resumeEvidenceErase(w.resumer, w.resumeErase, { millis: 60_000 });
    expect([...b.objects.keys()].filter((k) => /\/evidence(-pack)?\//u.test(k))).toEqual([key("own3", "ws3", "evidence", "t6", "b".repeat(64)), key("ownx", "wsx", "evidence-pack", "t9", `${DIGEST}.json`)]);
    expect(pendingOf(t)).toEqual([]);
  });

  it("a pass that fails before it saved any progress (the store errors) still leaves its pending record", async () => {
    const t = table();
    const b = populate();
    const broken = { send: async () => { throw new Error("store down"); } } as unknown as S3Client;
    await expect(createEvidenceErase({ s3: broken, artifactBucketName: "bucket", ...t }).project(ORG, "web")).rejects.toThrow("store down");
    expect(pendingOf(t)).toHaveLength(1);
    await resumeEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }, createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }), { millis: 60_000 });
    expect(pendingOf(t)).toEqual([]);
  });

  // PRF-3 (recheck2 gap 2): the pending record used to be written after two reads (the marker and the cursor); a transient error on either, during a close or an archive that swallows it, left nothing to resume.
  describe("a transient read error before the pending record exists", () => {
    it("is retried once: a marker or cursor read that fails once does not stop the erase or leave a record behind", async () => {
      const b = populate();
      const t = table({ failGets: { markerTimes: 1, pendingTimes: 1 } });
      await createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }).project(ORG, "web");
      expect(b.objects.has(key("own1", "ws1", "evidence-pack", "t1", `${DIGEST}.json`))).toBe(false);
      expect(pendingOf(t)).toEqual([]);
    });

    it("a marker read that keeps failing still leaves the pending record, so the scheduled run finishes the erase", async () => {
      const b = populate();
      const t = table({ failGets: { markerTimes: 2, pendingTimes: 0 } });
      await expect(createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }).project(ORG, "web")).rejects.toThrow("table unavailable");
      expect(pendingOf(t)).toHaveLength(1);
      expect(pendingOf(t)[0]).toMatchObject({ orgId: ORG, kind: "project", scopeKey: "web" });
      expect(await resumeEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }, createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...t }), { millis: 60_000 })).toEqual({ pending: 1, finished: 1 });
      expect(b.objects.has(key("own1", "ws1", "evidence-pack", "t1", `${DIGEST}.json`))).toBe(false);
      expect(b.objects.has(key("own2", "ws2", "evidence-pack", "t5", `${DIGEST}.json`))).toBe(false);
      expect(pendingOf(t)).toEqual([]);
    });

    it("a cursor read that keeps failing leaves the record and keeps the cursor an earlier pass saved", async () => {
      const b = populate();
      const failing = table({ failGets: { markerTimes: 0, pendingTimes: 2 } });
      failing.items.set("EVIDENCE_ERASE_PENDING|org-a|project|web", { pk: "EVIDENCE_ERASE_PENDING", sk: "org-a|project|web", orgId: ORG, kind: "project", scopeKey: "web", cursor: { i: 1 } });
      await expect(createEvidenceErase({ s3: b.s3, artifactBucketName: "bucket", ...failing }).project(ORG, "web")).rejects.toThrow("table unavailable");
      expect(pendingOf(failing)).toEqual([expect.objectContaining({ cursor: { i: 1 } })]);
    });
  });

  it("the scheduled run continues a company close from the project it stopped in, finishes a person's abandoned erase, and a store that keeps failing leaves the record for the next run", async () => {
    const t = table({ extraTasks: 3 });
    const b = populate();
    const w = interrupted(t, b);
    await w.slow.person(ORG, DEV).catch(() => undefined);
    await w.slow.workspace(ORG).catch(() => undefined);
    expect(pendingOf(t).map((item) => item.kind).sort()).toEqual(["person", "workspace"]);
    b.failDeletes.on = true;
    // The person's tasks had nothing left; the company's evidence cannot be deleted just now: its record stays.
    expect(await resumeEvidenceErase(w.resumer, w.resumeErase, { millis: 60_000 })).toEqual({ pending: 2, finished: 1 });
    expect(pendingOf(t).map((item) => item.kind)).toEqual(["workspace"]);
    b.failDeletes.on = false;
    expect(await resumeEvidenceErase(w.resumer, w.resumeErase, { millis: 60_000 })).toEqual({ pending: 1, finished: 1 });
    expect(evidenceLeft(b)).toEqual([]);
  });
});
