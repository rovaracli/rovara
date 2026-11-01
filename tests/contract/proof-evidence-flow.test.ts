// Proof and evidence (wire-proof), end to end through the broker: a verification (CHECKS) run is asked for evidence only while the proof switch is on; its raw file is assembled and kept when the result is accepted; the
// task page's view carries it (and the data guard has dropped what it must); the download route serves only what the current pack names, to a person who may read the task, and audits it. With the switch off nothing
// is asked, read, written, shown or mounted.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceViewSchema, createCandidateManifest, type EvidenceView } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema } from "../../packages/contracts/src/task-workflow-node.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, testedPlanDocument } from "../support/plan-documents.js";
import { evidencePackKey } from "../../packages/broker/src/rovara-code/evidence-keep.js";
import { createEvidencePort } from "../../packages/broker/src/aws/developer-tasks/evidence-port.js";
import { EVIDENCE_DOWNLOAD_PATH, routeEvidenceDownload } from "../../packages/broker/src/aws/task-evidence-download.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTaskActions } from "../../packages/broker/src/aws/broker/dependency-wiring.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const operationsOf = (harness: Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const EMAIL = "jane.doe@gmail.com";

afterEach(() => { delete process.env.PROOF_EVIDENCE_ENABLED; });

/** A version 2 task taken to the verification retry (a blocked VERIFY step), the checks operation asked for, and its payload. */
async function toChecks(on: boolean) {
  if (on) process.env.PROOF_EVIDENCE_ENABLED = "1";
  else delete process.env.PROOF_EVIDENCE_ENABLED;
  const harness = await createSingleAnswerPlanBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; ownerKey: string; workflow: Record<string, unknown> };
  const workspaceId = record().workspaceId;
  harness.db.set({ ...record(), workflow: { ...record().workflow, definitionVersion: "1.1.0", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operationsOf(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const planning = operationsOf(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
  await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(testedPlanDocument()));
  await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const planArtifact = (record().workflow as { artifacts: Array<{ type: string; sha256: string }> }).artifacts.filter((artifact) => artifact.type === "plan").at(-1)!;
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: (record().workflow as { revision: number }).revision, decision: "APPROVE", reason: "Approved", artifactDigest: planArtifact.sha256 });
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const implementation = operationsOf(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT");
  await harness.finish(workspaceId, String(implementation?.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
    checks: { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "failure" } } });
  const current = record() as unknown as { workflow: { revision: number } };
  const requestId = randomUUID();
  const retried = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId, instructions: "Run the selected check.", expectedRevision: current.workflow.revision });
  expect(retried.status).toBe(200);
  const checksOperation = operationsOf(harness, workspaceId).find((item) => item.requestId === requestId)!;
  const payload = (harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === checksOperation.id)[0]?.invocation as { payload: Record<string, unknown> }).payload;
  return { harness, taskId, workspaceId, ownerKey: record().ownerKey, candidate, checksOperation, payload };
}

const rawFor = (digest: string, names: string[]) => JSON.stringify({ schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", tests: {
  total: names.length, passed: names.length, failed: 0, skipped: 0, errored: 0, names: names.map((name) => ({ name, status: "passed" })), newTests: names.slice(0, 1) } }] });
const checksResult = (candidate: ReturnType<typeof createCandidateManifest>) => ({ result: {
  workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories,
  checks: { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" },
} });
const view = async (harness: Awaited<ReturnType<typeof toChecks>>["harness"], taskId: string) => (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`, undefined, { "x-agentx-task-view": "2" })).body.task as Record<string, unknown>;

describe("with the proof switch on", () => {
  it("asks the verification run for evidence, keeps what it wrote when the result is accepted, and the task view carries it, minus what the data guard dropped", async () => {
    const w = await toChecks(true);
    expect(w.payload.evidenceCapture).toBe(true);
    await w.harness.artifact(w.workspaceId, String(w.checksOperation.id), "evidence-raw.json", rawFor(w.candidate.digest, ["test_a", "test_b", `test_user_${EMAIL}`]));
    await w.harness.finish(w.workspaceId, String(w.checksOperation.id), "SUCCEEDED", checksResult(w.candidate));
    const task = await view(w.harness, w.taskId);
    // The names held an email: the part is dropped, the broker's own verdict stays, and the page says something was left out.
    const evidence = EvidenceViewSchema.parse(task["evidence"]);
    expect(evidence.candidateDigest).toBe(w.candidate.digest);
    expect(evidence.checks[0]).toMatchObject({ checkId: "readiness:0", after: "passed", label: "npm test" });
    expect(evidence.checks[0]?.tests).toBeUndefined();
    expect(evidence.notTested.some((item) => item.id === "data_guard")).toBe(true);
    expect(JSON.stringify(task)).not.toContain(EMAIL);
    // Of everything the evidence path stored (the pack and any tail), nothing holds the email; only the worker's own raw upload does.
    const kept = [...w.harness.s3.objects.entries()].filter(([key]) => key.includes("/evidence"));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.some(([, text]) => text.includes(EMAIL))).toBe(false);
    expect([...w.harness.s3.objects.entries()].some(([key, text]) => key.includes(`/${String(w.checksOperation.id)}/`) && text.includes(EMAIL))).toBe(true);
    // The pack is stored under the task and the exact code.
    expect(w.harness.s3.objects.has(evidencePackKey({ ownerKey: w.ownerKey, workspaceId: w.workspaceId, taskId: w.taskId }, w.candidate.digest))).toBe(true);
    // A client that does not send the version 2 header never receives it.
    expect((await w.harness.dev(MAYA, "GET", `/v1/dev/tasks/${w.taskId}`)).body.task).not.toHaveProperty("evidence");
  });

  it("shows the test details when nothing is dropped, and a raw file for other code leaves no evidence about this code", async () => {
    const w = await toChecks(true);
    await w.harness.artifact(w.workspaceId, String(w.checksOperation.id), "evidence-raw.json", rawFor(w.candidate.digest, ["test_a", "test_b"]));
    await w.harness.finish(w.workspaceId, String(w.checksOperation.id), "SUCCEEDED", checksResult(w.candidate));
    const evidence = EvidenceViewSchema.parse((await view(w.harness, w.taskId))["evidence"]);
    expect(evidence.checks[0]).toMatchObject({ kind: "test", tests: { total: 2, passed: 2 } });
    const other = await toChecks(true);
    await other.harness.artifact(other.workspaceId, String(other.checksOperation.id), "evidence-raw.json", rawFor("f".repeat(64), ["test_a"]));
    await other.harness.finish(other.workspaceId, String(other.checksOperation.id), "SUCCEEDED", checksResult(other.candidate));
    expect(await view(other.harness, other.taskId)).not.toHaveProperty("evidence");
  });

  it("serves a stored artifact only to a person who may read the task, only what the current pack names, and audits each download", async () => {
    const w = await toChecks(true);
    const tail = "FAILED test_x - AssertionError";
    await w.harness.artifact(w.workspaceId, String(w.checksOperation.id), "evidence-raw.json", JSON.stringify({ schemaVersion: 1, candidateDigest: w.candidate.digest, checks: [{ checkId: "readiness:0", outputTail: tail }] }));
    await w.harness.finish(w.workspaceId, String(w.checksOperation.id), "SUCCEEDED", checksResult(w.candidate));
    const dependencies = w.harness.brokerInput as never;
    const port = createEvidencePort({ actions: developerTaskActions(dependencies), store: { s3: w.harness.s3 as never, artifactBucketName: "bucket" } });
    const task = w.harness.db.get(`DEVTASK#${w.taskId}`, "META") as never;
    const packView: EvidenceView = (await port.view(w.harness.db.get(`DEVTASK#${w.taskId}`, "META") as never, w.candidate.digest))!;
    expect(packView.checks[0]?.outputTailRef?.state).toBe("expired"); // the in-memory store has no HeadObject: the page never shows a link for a file it could not confirm
    const sha = createHash("sha256").update(tail).digest("hex");
    const recorded: unknown[] = [];
    const download = (resolveAccess: never, hash = sha, record = async (event: unknown) => { recorded.push(event); }) => routeEvidenceDownload({
      deps: { evidence: { ...port, view: async () => ({ ...packView, checks: [{ ...packView.checks[0]!, outputTailRef: { ...packView.checks[0]!.outputTailRef!, state: "available", href: `/v1/app/tasks/${w.taskId}/evidence/${sha}` } }] }) } } as never,
      caller: { orgId: "org", developerId: "dev-1", sessionId: "s", amr: "oidc", name: "x", orgRole: "member" } as never, taskId: w.taskId, sha256: hash, requestId: randomUUID(), now: () => Date.parse("2026-11-03T00:00:00Z"),
      resolveAccess, record,
    });
    const reader = (async () => ({ task: { ...(task as object), workflow: { candidate: w.candidate } }, role: "viewer", source: "task", ownerActorIds: [] })) as never;
    const ok = await download(reader);
    expect(ok?.response.statusCode).toBe(200);
    expect(Buffer.from(ok!.response.body, "base64").toString("utf8")).toBe(tail);
    expect(ok?.response.headers["content-disposition"]).toBe("attachment");
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain(tail);
    // A hash the current pack does not name is not there; a person who may not read the task is told 403 and nothing is audited.
    expect((await download(reader, "0".repeat(64)))?.response.statusCode).toBe(404);
    recorded.length = 0;
    const stranger = (async () => { throw Object.assign(new Error("no"), { code: "TASK_NOT_FOUND" }); }) as never;
    expect((await download(stranger))?.response.statusCode).toBe(403);
    const noRead = (async () => ({ task: (task as object), role: "denied", source: "task", ownerActorIds: [] })) as never;
    expect((await download(noRead))?.response.statusCode).toBe(403);
    expect(recorded).toHaveLength(0);
    // A download that cannot be audited does not happen.
    const failing = await download(reader, sha, async () => { throw new Error("ledger down"); });
    expect(failing?.response.statusCode).toBe(503);
    expect(failing?.response.body).not.toContain(tail);
  });
});

describe("with the proof switch off (the default)", () => {
  it("asks for nothing, reads nothing, writes nothing, shows nothing, and mounts no route", async () => {
    const w = await toChecks(false);
    expect(w.payload).not.toHaveProperty("evidenceCapture");
    const before = new Set(w.harness.s3.objects.keys());
    await w.harness.artifact(w.workspaceId, String(w.checksOperation.id), "evidence-raw.json", rawFor(w.candidate.digest, ["test_a", "test_b"]));
    const stored = new Set(w.harness.s3.objects.keys());
    w.harness.s3.send.mockClear();
    await w.harness.finish(w.workspaceId, String(w.checksOperation.id), "SUCCEEDED", checksResult(w.candidate));
    const after = [...w.harness.s3.objects.keys()].filter((key) => !before.has(key) && !stored.has(key));
    expect(after.filter((key) => key.includes("/evidence"))).toEqual([]);
    expect(await view(w.harness, w.taskId)).not.toHaveProperty("evidence");
    // No read of the raw file by the evidence path.
    const reads = w.harness.s3.send.mock.calls.map((call) => (call[0] as { input: { Key?: string } }).input.Key ?? "").filter((key) => key.endsWith("evidence-raw.json"));
    expect(reads).toEqual([]);
    // The route is not one: no port, no answer.
    expect(await routeEvidenceDownload({ deps: {} as never, caller: {} as never, taskId: randomUUID(), sha256: "a".repeat(64), requestId: "r", now: Date.now })).toBeUndefined();
    expect(EVIDENCE_DOWNLOAD_PATH.test(`/v1/app/tasks/${randomUUID()}/evidence/${"a".repeat(64)}`)).toBe(true);
  });

  it("a workflow that is not version 2 never carries evidence, switch on or not", async () => {
    const w = await toChecks(true);
    const record = w.harness.db.get(`DEVTASK#${w.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    expect(WorkflowSnapshotSchema.safeParse(record.workflow).success).toBe(true);
    expect(await view(w.harness, w.taskId)).not.toHaveProperty("evidence");
    void OMAR; void developerTaskRouteDependencies;
  });
});
