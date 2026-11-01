// Proof and evidence (wire-proof), the broker's half: the evidence of a verification run is assembled and kept once, only while the proof switch is on. The worker's raw file is untrusted; the data guard drops
// every part that holds personal data, a credential or production data BEFORE anything is stored, shown or posted; a pack is read back only for the exact code it was kept for.
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, type CheckEntry, type TestEnvProdDeny } from "../../packages/contracts/src/index.js";
import { evidenceFindings, guardPack, guardRaw, evidenceTexts } from "../../packages/broker/src/rovara-code/evidence-guard.js";
import { evidencePackKey, keepEvidence, loadEvidencePack, policyKindsOf, type KeepEvidenceDeps } from "../../packages/broker/src/rovara-code/evidence-keep.js";
import { keepEvidenceAfterChecks, evidenceRouteDependencies } from "../../packages/broker/src/aws/broker/evidence-wiring.js";

const DIGEST = "c".repeat(64);
const OTHER = "e".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const names = (...list: string[]) => list.map((name) => ({ name, status: "passed" as const }));
const tests = (list: string[], over: Record<string, unknown> = {}) => ({ total: list.length, passed: list.length, failed: 0, skipped: 0, errored: 0, names: names(...list), newTests: list.slice(0, 1), ...over });
const rawOf = (checks: unknown[], digest = DIGEST) => ({ schemaVersion: 1, candidateDigest: digest, checks, selection: { method: "full", selected: 3, total: 3 } });

/** An in-memory bucket and the artifact listing the broker reads the raw file through. */
function world(rawText: string | undefined, over: { key?: string } = {}) {
  const objects = new Map<string, string>();
  const sent: string[] = [];
  const s3 = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, String(command.input.Body as string)); sent.push(`put ${command.input.Key!}`); return {}; }
    if (command instanceof GetObjectCommand) { const found = objects.get(command.input.Key!); if (found === undefined) throw new Error("NoSuchKey"); return { Body: { transformToString: async () => found } }; }
    throw new Error("unexpected command");
  } } as unknown as S3Client;
  const reads: string[] = [];
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() { return rawText === undefined ? [] : [{ name: "evidence-raw.json", objectKey: over.key ?? `${PREFIX}evidence-raw.json` }]; },
    async readArtifact(key, max) { reads.push(key); return key.startsWith(PREFIX) && rawText !== undefined ? rawText.slice(0, max) : objects.get(key) ?? ""; },
  };
  const deps: KeepEvidenceDeps = { actions: { ...actions, readArtifact: async (key, max) => (objects.has(key) ? objects.get(key)!.slice(0, max) : actions.readArtifact(key, max)) }, store: { s3, artifactBucketName: "bucket" } };
  return { deps, objects, sent, reads };
}
const input = (over: Record<string, unknown> = {}) => ({ task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q"), entry("readiness:1", "ruff check .")], ...over });

describe("assembling the evidence of a run", () => {
  it("keeps a pack bound to the code, with the test details from the worker, the broker's own verdicts, and the output tail of a failed check stored first", async () => {
    const tail = "FAILED tests/test_match.py::test_scores - AssertionError";
    const w = world(JSON.stringify(rawOf([
      { checkId: "readiness:0", tests: tests(["test_a", "test_b", "test_c"]) },
      { checkId: "readiness:1", outputTail: tail },
    ])));
    const result = await keepEvidence(w.deps, input({ checks: [entry("readiness:0", "pytest -q"), entry("readiness:1", "ruff check .", { after: "failed", exitCode: 1 })] }));
    expect(result).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(w.deps.actions, TASK, DIGEST);
    expect(pack?.candidateDigest).toBe(DIGEST);
    expect(EvidencePackSchema.safeParse(pack).success).toBe(true);
    expect(pack?.checks[0]).toMatchObject({ checkId: "readiness:0", kind: "test", label: "pytest -q", after: "passed" });
    expect(pack?.checks[0]?.tests?.total).toBe(3);
    const tailRef = pack?.checks[1]?.outputTailRef;
    expect(tailRef?.kind).toBe("log_txt");
    // The tail is in the store, under the task, before the pack names it.
    expect(w.objects.get(`private/${TASK.ownerKey}/${TASK.workspaceId}/evidence/${TASK.taskId}/${tailRef!.sha256}`)).toBe(tail);
    expect(createHash("sha256").update(tail).digest("hex")).toBe(tailRef!.sha256);
    // No approved test environment: the pack says so, and does not claim a setup.
    expect(pack?.environment).toMatchObject({ tier: "sandbox", envRevision: 0, services: [] });
    expect(pack?.notTested.some((item) => item.id === "test_environment")).toBe(true);
  });

  it("is read back only for the exact code: another digest, and a key of another task, give nothing", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    await keepEvidence(w.deps, input());
    expect(await loadEvidencePack(w.deps.actions, TASK, OTHER)).toBeUndefined();
    expect(await loadEvidencePack(w.deps.actions, { ...TASK, taskId: "task-2" }, DIGEST)).toBeUndefined();
    expect(await loadEvidencePack(w.deps.actions, TASK, undefined)).toBeUndefined();
    // A pack kept for other code, found under this code's key, is not this code's.
    w.objects.set(evidencePackKey(TASK, OTHER), w.objects.get(evidencePackKey(TASK, DIGEST))!);
    expect(await loadEvidencePack(w.deps.actions, TASK, OTHER)).toBeUndefined();
    expect(await loadEvidencePack(w.deps.actions, TASK, "../../etc")).toBeUndefined();
    expect(evidencePackKey(TASK, DIGEST)).toBe(`private/owner-1/ws-1/evidence-pack/task-1/${DIGEST}.json`);
  });

  it("keeps nothing for a raw file of other code, none at all, an unreadable one, or one outside the operation's own prefix", async () => {
    const good = JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }]));
    expect(await keepEvidence(world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }], OTHER))).deps, input())).toEqual({ kept: false, reason: "not_bound" });
    expect(await keepEvidence(world(undefined).deps, input())).toEqual({ kept: false, reason: "no_raw" });
    expect(await keepEvidence(world(good, { key: `private/another-owner/${TASK.workspaceId}/${OP}/evidence-raw.json` }).deps, input())).toEqual({ kept: false, reason: "no_raw" });
    // Unreadable: the pack still holds what the broker knows itself, and says the details could not be read.
    const unreadable = world("{ not json");
    expect(await keepEvidence(unreadable.deps, input())).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(unreadable.deps.actions, TASK, DIGEST);
    expect(pack?.checks.every((check) => check.tests === undefined)).toBe(true);
    expect(pack?.notTested.some((item) => item.reason === "could not be read")).toBe(true);
  });

  it("does not trust a count: a worker that reports failures for a passed check loses those test details", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"], { passed: 2, failed: 1 }) }])));
    await keepEvidence(w.deps, input());
    const pack = await loadEvidencePack(w.deps.actions, TASK, DIGEST);
    expect(pack?.checks[0]?.tests).toBeUndefined();
  });

  it("writes nothing more once its time has run out", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    const result = await keepEvidence({ ...w.deps, late: () => true }, input());
    expect(result).toEqual({ kept: false, reason: "fault" });
    expect(w.sent).toEqual([]);
  });

  it("never throws: a store that fails is only no evidence", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    const broken = { ...w.deps, store: { s3: { send: async () => { throw new Error("down"); } } as unknown as S3Client, artifactBucketName: "bucket" } };
    expect(await keepEvidence(broken, input())).toEqual({ kept: false, reason: "fault" });
  });

  it("takes the approved policy's kind for a check, and treats a check with a test report as a test check", () => {
    expect([...policyKindsOf([{ kind: "lint" }, {}, { kind: "security" }])]).toEqual([["readiness:0", "lint"], ["readiness:2", "security"]]);
  });
});

describe("the data guard on the evidence", () => {
  const EMAIL = "jane.doe@gmail.com";
  const CARD = "4111 1111 1111 1111";
  const SECRET = `AKIA${"ABCDEFGHIJKLMNOP"}`;

  it("drops a check's test names that hold an email, and says so; the broker's verdict for that check stays; other checks keep theirs", async () => {
    const w = world(JSON.stringify(rawOf([
      { checkId: "readiness:0", tests: tests([`test_user_${EMAIL}`, "t2", "t3"]) },
      { checkId: "readiness:1", tests: tests(["u1", "u2", "u3"]) },
    ])));
    const result = await keepEvidence(w.deps, input());
    expect(result).toMatchObject({ kept: true, guardedParts: 1 });
    const pack = await loadEvidencePack(w.deps.actions, TASK, DIGEST);
    expect(pack?.checks[0]).toMatchObject({ checkId: "readiness:0", after: "passed" });
    expect(pack?.checks[0]?.tests).toBeUndefined();
    expect(pack?.checks[1]?.tests?.total).toBe(3);
    expect(pack?.notTested.some((item) => item.id === "data_guard")).toBe(true);
    // The matched text is nowhere: not in the pack, not in anything stored.
    expect(JSON.stringify(pack)).not.toContain(EMAIL);
    expect([...w.objects.values()].join("\n")).not.toContain(EMAIL);
  });

  it("drops an output tail with a card number or a credential: nothing of it is stored, and the pack names no tail", async () => {
    for (const bad of [`charged ${CARD} ok`, `AWS_ACCESS_KEY_ID=${SECRET}`]) {
      const w = world(JSON.stringify(rawOf([{ checkId: "readiness:1", outputTail: `step\n${bad}\n` }])));
      const result = await keepEvidence(w.deps, input({ checks: [entry("readiness:0", "pytest -q"), entry("readiness:1", "ruff", { after: "failed", exitCode: 1 })] }));
      expect(result).toMatchObject({ kept: true });
      const pack = await loadEvidencePack(w.deps.actions, TASK, DIGEST);
      expect(pack?.checks[1]?.outputTailRef).toBeUndefined();
      expect([...w.objects.keys()].some((key) => key.includes("/evidence/"))).toBe(false);
      expect([...w.objects.values()].join("\n")).not.toContain("4111");
      expect([...w.objects.values()].join("\n")).not.toContain(SECRET);
    }
  });

  it("drops a part that names a host on the company's production deny list", async () => {
    const deny: TestEnvProdDeny = { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] };
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["test_calls_api.prod.example.com", "t2", "t3"]) }])));
    const result = await keepEvidence(w.deps, input({ deny }));
    expect(result).toMatchObject({ kept: true, guardedParts: 1 });
    expect((await loadEvidencePack(w.deps.actions, TASK, DIGEST))?.checks[0]?.tests).toBeUndefined();
    // The same names pass when no list names the host.
    const clean = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["test_calls_api.prod.example.com", "t2", "t3"]) }])));
    await keepEvidence(clean.deps, input());
    expect((await loadEvidencePack(clean.deps.actions, TASK, DIGEST))?.checks[0]?.tests?.total).toBe(3);
  });

  it("a digest or a timestamp is not scanned: 64 hex characters with a long digit run are not a card", () => {
    const digest = `${"1".repeat(10)}${"a".repeat(54)}`;
    expect(evidenceTexts({ sha: digest, at: "2026-11-02T00:00:00.000Z", name: "x" })).toEqual(["x"]);
    expect(evidenceFindings({ sha: "4111111111111111".padEnd(64, "a") }, { accountIds: [], hosts: [], arnPrefixes: [] })).toEqual([]);
  });

  it("the built pack is checked again: a check label that holds an email (a command the repository wrote) becomes a numbered label, and nothing is stored with it", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    const result = await keepEvidence(w.deps, input({ checks: [entry("readiness:0", `curl https://api.example.com --user ${EMAIL}`), entry("readiness:1", "ruff check .")] }));
    expect(result).toMatchObject({ kept: true, guardedParts: 1 });
    const pack = await loadEvidencePack(w.deps.actions, TASK, DIGEST);
    expect(pack?.checks[0]?.label).toBe("Check 1");
    expect(pack?.checks[1]?.label).toBe("ruff check .");
    expect([...w.objects.values()].join("\n")).not.toContain(EMAIL);
  });

  it("guardPack drops an output tail that holds a finding, with the stored text, and keeps the broker's verdict", () => {
    const text = `charged ${CARD} ok`;
    const ref = { kind: "log_txt" as const, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), retentionClass: "evidence-std" as const };
    const pack = { schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, checks: [{ checkId: "a", kind: "other", label: "x", before: "passed", after: "failed", class: "passing", durationMs: 1, outputTailRef: ref }], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [], notTested: [] } as never;
    const guarded = guardPack(pack, [{ ref, text }], { accountIds: [], hosts: [], arnPrefixes: [] });
    expect(guarded.newArtifacts).toEqual([]);
    expect(guarded.pack?.checks[0]).not.toHaveProperty("outputTailRef");
    expect(guarded.pack?.checks[0]).toMatchObject({ checkId: "a", after: "failed" });
    expect(guarded.dropped.kinds).toContain("card_number");
  });

  it("fails closed on a text it cannot scan", () => {
    expect(evidenceFindings({ name: "x".repeat(5 * 1024 * 1024) }, { accountIds: [], hosts: [], arnPrefixes: [] })).toEqual(["secret"]);
  });

  it("guardRaw and guardPack work on values: a flagged label becomes a numbered one, a flagged environment withholds the pack", () => {
    const raw = guardRaw({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "a", tests: tests([`x ${EMAIL}`]) }, { checkId: "b" }] } as never, { accountIds: [], hosts: [], arnPrefixes: [] });
    expect(raw.raw.checks.map((check) => check.checkId)).toEqual(["b"]);
    expect(raw.dropped.parts).toBe(1);
    expect(raw.dropped.kinds).toEqual(["email"]);
    const pack = { schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, checks: [{ checkId: "a", kind: "other", label: `run ${EMAIL}`, before: "passed", after: "passed", class: "passing", durationMs: 1 }], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [], notTested: [] } as never;
    expect(guardPack(pack, [], { accountIds: [], hosts: [], arnPrefixes: [] }).pack?.checks[0]?.label).toBe("Check 1");
    const bad = { ...(pack as object), notTested: [{ kind: "environment", id: "x", text: `see ${EMAIL}`, reason: "r" }] } as never;
    expect(guardPack(bad, [], { accountIds: [], hosts: [], arnPrefixes: [] }).pack).toBeUndefined();
  });
});

describe("the switch", () => {
  const dependencies = (w: ReturnType<typeof world>) => ({ s3: w.deps.store.s3, artifactBucketName: "bucket", tableName: "t", documentClient: { send: async () => ({}) } }) as never;
  const task = { taskId: TASK.taskId, ownerKey: TASK.ownerKey, workspaceId: TASK.workspaceId };
  const args = (workflowMode: "CHECKS" | "IMPLEMENT" = "CHECKS") => ({ task, operation: { id: OP, workflowMode } as never, workflow: { checkPolicy: undefined } as never, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")] });

  it("off (the default, or anything but exactly 1): no read, no write, no route dependency", async () => {
    for (const value of [undefined, "0", "true", "", " 1"]) {
      const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
      const env = value === undefined ? {} : { PROOF_EVIDENCE_ENABLED: value };
      expect(await keepEvidenceAfterChecks(dependencies(w), args(), env as NodeJS.ProcessEnv), JSON.stringify(value)).toBeUndefined();
      expect(w.sent).toEqual([]);
      expect(w.reads).toEqual([]);
      expect(evidenceRouteDependencies(dependencies(w), env as NodeJS.ProcessEnv)).toEqual({});
    }
  });

  it("on: a CHECKS run is kept; an implementation run is not (it has no test reports)", async () => {
    const env = { PROOF_EVIDENCE_ENABLED: "1" } as NodeJS.ProcessEnv;
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    expect(await keepEvidenceAfterChecks(dependencies(w), args("IMPLEMENT"), env)).toBeUndefined();
    expect(w.sent).toEqual([]);
    expect(evidenceRouteDependencies(dependencies(w), env).evidence).toBeDefined();
  });
});
