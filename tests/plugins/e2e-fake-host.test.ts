// Enterprise foundations P10: one Rovara Code task, from a request to "merged", on the fake host: FakeTracker asks for the work, FakeCodeHost holds the repository and the change request,
// FakeCheckRunner runs the check, and nothing is GitHub. The broker is the real one (the developer-task broker over an in-memory table); the worker is played by the test, which does what a
// worker does (it reports the prepared base, the plan, the checked candidate, the pushed commit) against the fake host's repository. GitHub is a stand-in that FAILS if it is asked
// anything: a step that still went to GitHub for this repository would stop the journey here.
//
// The second half proves the journey needs each method of the port: with any method the journey used taken away from the host, the journey does not reach "merged".
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CodeIntentRequestSchema, editionPolicy, type CodeHost, type CodeIntentRequest,
} from "@agentx/contracts";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import { portCredentialResolver } from "../../packages/broker/src/aws/broker/credential-exchange.js";
import type { IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCheckRunner, FAKE_RUNNER_KIND } from "../../packages/broker/src/plugins/fake/check-runner.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FakeTracker, fakeTrackerDelivery } from "../../packages/broker/src/plugins/fake/tracker.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { startFromTrackerDelivery } from "../../packages/broker/src/plugins/tracker/start.js";
import { linkedChangeRequestItem } from "../../packages/broker/src/rovara-code/linked-change-requests.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { SCOPE } from "./fake-worlds.js";

const REPO = "https://git.example.test/acme/demo";
const WORK = { "src/retry.ts": "export const retries = 3;\n" };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

/** GitHub as the broker would see it if it were asked: it is not. Every method refuses, naming itself, so a leak shows which step went to GitHub. */
function githubMustNotBeAsked(): Record<string, unknown> {
  return new Proxy({}, { get: (_target, name) => (typeof name === "string" && name !== "then"
    ? vi.fn(async () => { throw new Error(`GitHub was asked: ${name}`); })
    : undefined) });
}

/** The fake host, with every method call recorded, and optionally one method taken away. */
function watched(host: FakeCodeHost, calls: Set<string>, without: string | undefined): CodeHost {
  return new Proxy<FakeCodeHost>(host, {
    get(target, name, receiver) {
      if (typeof name === "string" && name === without) return undefined;
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function" || typeof name !== "string" || name === "constructor") return value;
      return (...args: unknown[]) => { calls.add(name); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
}

async function world(without?: string) {
  const model = new FakeHostModel({ url: REPO, id: "42", fullName: "acme/demo", webBase: "https://git.example.test" });
  const fakeHost = new FakeCodeHost(model);
  const runner = new FakeCheckRunner(model);
  const tracker = new FakeTracker({ project: "payments" });
  const calls = new Set<string>();
  const github = githubMustNotBeAsked();
  const registry = createPluginRegistry({
    codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), watched(fakeHost, calls, without)],
    checkRunners: [{ kind: FAKE_RUNNER_KIND, create: () => runner }], trackers: [tracker], policy: editionPolicy("enterprise"),
  });
  const grants = new RepositoryGrantService(Buffer.alloc(32, 4), portCredentialResolver({ codeHost: registry.codeHost, credentialRef: "github-app" }));
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { githubPullRequests: github, codeHost: registry.codeHost, checkRunner: registry.checkRunner, repositoryGrants: grants } });
  // A repository's code host is READ by this release but not written by a save (the registration schema refuses `host`), so the stored project is patched the way a later release's save would
  // leave it: the one repository lives on the fake host.
  const project = harness.db.find((item) => item.entityType === "PROJECT" && (item.definition as { name?: string } | undefined)?.name === "payments")[0]!;
  const definition = project.definition as { repositories: Array<Record<string, unknown>> };
  harness.db.set({ ...project, definition: { ...definition, repositories: definition.repositories.map((repository) => ({ ...repository, url: REPO, host: { kind: "fake" } })) } });
  return { model, fakeHost, runner, tracker, calls, harness, registry };
}
type World = Awaited<ReturnType<typeof world>>;

/** The request: a member labels an item at the tracker; the delivery is verified, the item read, and the intake rule starts one Quick task as that member. */
async function startFromTracker(w: World): Promise<{ taskId: string; request: CodeIntentRequest }> {
  w.tracker.addItem("ENG-1", { title: "Fix the retry bug", body: "Retries stop after one attempt." });
  const started: Array<{ taskId: string; request: CodeIntentRequest }> = [];
  const bound = new Set<string>();
  const ports: IntakePorts = {
    table: { documentClient: w.harness.db, tableName: "state", now: Date.now },
    log: () => undefined,
    memberOfAccount: async (_org, system, account) => (system === "fake-tracker" && account === "acct-maya" ? MAYA.developerId : undefined),
    mayStart: async () => true,
    // The start service is the developer-task route, as the member (the intent route of an install with agents is not part of this harness).
    start: async (_org, _developerId, request) => {
      const answer = await w.harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: request.project, instructions: request.input.text, client: "tracker", workflow: true, workflowPath: "QUICK" });
      if (answer.status !== 200) throw new Error(`the start was refused: ${JSON.stringify(answer.body)}`);
      const taskId = String((answer.body.task as { taskId: string }).taskId);
      started.push({ taskId, request });
      if (request.binding?.kind === "tracker_item") bound.add(`${request.binding.system}:${request.binding.id}`);
      return { task: { taskId } };
    },
    sessionOfTicket: async (_org, binding) => (bound.has(`${binding.system}:${binding.id}`) ? { sessionId: "ses_00000000000000000001" } : undefined),
  };
  const results = await startFromTrackerDelivery({
    ports, orgId: TEST_ORG, project: "payments", tracker: w.registry.tracker("fake-tracker"), scope: SCOPE,
    delivery: fakeTrackerDelivery({ delivery: "d-1", event: "labelled", item: "ENG-1", label: "rovara", labelledBy: "acct-maya" }),
  });
  expect(results[0]?.outcome).toMatchObject({ outcome: "started" });
  expect(CodeIntentRequestSchema.safeParse(started[0]!.request).success).toBe(true);
  return started[0]!;
}

/** Everything from the request to "merged". Returns what the broker holds for the task at the end. */
async function journey(w: World, options: { anotherTaskHoldsTheChangeRequest?: boolean } = {}) {
  const { harness, model, runner } = w;
  const { taskId, request } = await startFromTracker(w);
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });

  // Preparation: the worker cloned the base from the fake host's repository.
  const base = model.headOf("main");
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: base }] } });
  // Plan, approved by the owner.
  const plan = "# Plan\n\n1. Retry three times.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  const revision = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
  const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
  expect(approved.status).toBe(200);
  // Implementation: the worker's workspace holds the change; its tree is what the checks and reviews are about, and what the publication must push.
  const work = model.commit("scratch/work", WORK);
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: work, treeSha: model.revision(work).tree, baseCommitSha: base }]);
  const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
  // Both reviews pass.
  const review = operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!;
  const now = new Date().toISOString();
  await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
    workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: String(review.id), candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
  // Publication: the worker pushes the checked tree to the head branch of the fake host's repository, and reports the commit; the broker opens the change request there.
  const publish = operations(harness, workspaceId).find((item) => item.kind === "publish") as { id: string; publication: { repository: string; repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body?: string } } | undefined;
  if (publish === undefined) throw new Error("no publication was started");
  const p = publish.publication;
  const pushed = model.commit(p.headBranch, WORK);
  const opened = await harness.callback(workspaceId, publish.id, "pull-request", { repository: p.repository, repositoryUrl: p.repositoryUrl, headBranch: p.headBranch, baseBranch: p.baseBranch, commit: pushed, title: p.title, ...(p.body === undefined ? {} : { body: p.body }) }) as { number: number; url: string };
  if (options.anotherTaskHoldsTheChangeRequest === true) {
    // Another task already holds this change request (its neutral link row): the publication's result is refused, and this task does not follow it.
    const held = linkedChangeRequestItem("state", { hostKind: "fake", repositoryAddress: REPO, changeRequestId: String(opened.number), repositoryId: "demo", number: opened.number, url: opened.url, taskId: randomUUID(), workspaceId: randomUUID(), candidateDigest: candidate.digest, createdAt: new Date().toISOString() });
    harness.db.set(held!.Put.Item as unknown as Record<string, unknown>);
  }
  await harness.finish(workspaceId, publish.id, "SUCCEEDED", { result: { repository: "demo", number: opened.number, url: opened.url, headBranch: p.headBranch, baseBranch: "main", commit: pushed, checks: [], reconciled: false } });
  const waiting = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { stage: string; state: string; pullRequests?: Array<{ number: number; headSha: string }> } }).workflow;
  expect(waiting).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ number: opened.number, headSha: pushed }] });
  // The check runs on the pushed revision, through the runner, and passes.
  const started = await w.registry.checkRunner(FAKE_RUNNER_KIND, { allowedRepositories: [REPO] }).start!({ repository: { url: REPO }, revision: pushed, gate: "unit", project: "payments-ci", timeoutMinutes: 10, idempotencyKey: "run-1" }, SCOPE);
  runner.finish(started.run.id, "success", "all green");
  // A person merges the change request at the host (Rovara never merges by itself); the recovery pass observes the host and the task is merged.
  const ref = { repository: { url: REPO }, id: String(opened.number), url: opened.url };
  // The publication opened the change request as a draft; the checks passed, so it is taken out of draft (what the tracking pass does for a project that has it on) and then merged.
  await w.registry.codeHost.forKind("fake").markReady!(ref, SCOPE);
  const merged = await w.registry.codeHost.forKind("fake").merge!(ref, { revision: pushed, method: "squash" }, SCOPE);
  expect(merged).toMatchObject({ outcome: "merged" });
  await harness.handler({ source: "agentx.workflow-merge-recovery" });
  const finished = harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { stage: string; state: string; outcome?: string } };
  return { taskId, workspaceId, request, pushed, opened, workflow: finished.workflow };
}

/** The methods of the CodeHost port this journey uses, found by running it: taking any one of them away must stop the journey short of "merged". */
const METHODS_THE_JOURNEY_USES = ["branchHead", "commitParents", "feedback", "getChangeRequest", "markReady", "merge", "mergeObservation", "reconcileChangeRequest", "tree"];

describe("a Rovara Code task on the fake host", () => {
  it("goes from a request at the tracker to merged on the fake host, with GitHub never asked", async () => {
    const w = await world();
    const done = await journey(w);
    expect(w.model.changeRequests).toHaveLength(1);
    expect(w.model.getChangeRequest(String(done.opened.number))).toMatchObject({ sourceBranch: expect.stringMatching(/^agentx\//) as string, state: "merged" });
    expect(done.request.source).toBe("tracker");
    expect(done.workflow).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    // The journey used exactly these methods of the port (a method added to the journey, or dropped from it, is a change to review).
    expect([...w.calls].sort()).toEqual(METHODS_THE_JOURNEY_USES);
  }, 120_000);

  it("does not follow a change request another task already holds: the publication's result is refused", async () => {
    const w = await world();
    await expect(journey(w, { anotherTaskHoldsTheChangeRequest: true })).rejects.toThrow(/already linked to another task or candidate/);
  }, 120_000);

  it.each(METHODS_THE_JOURNEY_USES)("does not reach merged when the host has no %s", async (method) => {
    const w = await world(method);
    const reached = await journey(w).then((done) => done.workflow, () => "stopped" as const);
    expect(reached === "stopped" ? "stopped" : reached.stage).not.toBe("MERGED");
  }, 120_000);
});
