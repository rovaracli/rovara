// Meta repo lane D (D2/D3/D4): the task-side wiring of the spec, against the broker's own table (a fake DynamoDB). With no spec target nothing happens; with one, the approval records the obligation, the
// review and the code pull request each wait for what they need of the spec, and a published spec's link and requirements are read back from the recorded commit.
import { createHash, randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import type { SpecFile, SpecTarget, WorkflowSnapshot } from "@agentx/contracts";
import { SpecTargetSchema } from "@agentx/contracts";
import { specEndEnvironmentOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { specAfterPlanApproval, specOwnerChoice, specPublicationGate, specReviewGate } from "../../packages/broker/src/aws/developer-tasks/spec-wiring.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks/types.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { kiroRenderer } from "../../packages/broker/src/spec/index.js";
import { dynamoSpecStore } from "../../packages/broker/src/spec/store.js";
import { newSpecState, publishSucceeded, startWriting, writeSucceeded, type SpecState } from "../../packages/broker/src/spec/state.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK = randomUUID();
const WORKSPACE = randomUUID();
const PLAN_TEXT = "Add a password reset route.";
const PLAN_DIGEST = createHash("sha256").update(PLAN_TEXT, "utf8").digest("hex");
const BASE = "b".repeat(40);
const SPEC_COMMIT = "c".repeat(40);
const META = "https://github.com/acme/service-meta";
const NOW = "2026-10-31T10:00:00.000Z";
const target = (overrides: Partial<SpecTarget> = {}): SpecTarget => SpecTargetSchema.parse({ format: "kiro", ...overrides });

const repositories = (withMeta: boolean) => [
  { name: "web", url: "https://github.com/acme/web", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" },
  ...(withMeta ? [{ name: "service-meta", url: META, path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" }] : []),
];
const definition = (specTarget: SpecTarget | undefined, withMeta = true) => ({ name: "demo", revision: 3, repositories: repositories(withMeta), setup: [], readiness: [], ...(specTarget === undefined ? {} : { specTarget }) });

function workflow(approved: "owner" | "agentx" | "none" = "owner"): WorkflowSnapshot {
  return {
    artifacts: [{ id: "plan-1", type: "plan", version: 1, objectKey: "plans/1", sha256: PLAN_DIGEST, format: "markdown" }],
    decisions: approved === "none" ? [] : [{ decision: "APPROVE", artifactDigest: PLAN_DIGEST, actorRole: approved === "owner" ? "TASK_OWNER" : "AGENTX", requestId: "r", workflowRevision: 1, actorId: "a", at: NOW }],
    stage: "REVIEW", state: "WAITING", revision: 4,
  } as unknown as WorkflowSnapshot;
}

async function setup(options: { specTarget?: SpecTarget | undefined; withMeta?: boolean; approved?: "owner" | "agentx" | "none"; knowledgeCommit?: string | undefined; readMetaFile?: DeveloperTaskRouteDependencies["readMetaFile"] } = {}) {
  const db = new FakeDynamoDb();
  const task = { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, workspaceId: WORKSPACE, project: "demo", title: "Reset password", startingRevision: 3, orgId: "org-1", conversationId: randomUUID(),
    ...(options.knowledgeCommit === undefined && "knowledgeCommit" in options ? {} : { knowledgeCommit: options.knowledgeCommit ?? BASE }), workflow: workflow(options.approved), preparedBase: [{ repositoryId: "web", baseCommitSha: "1".repeat(40) }] } as unknown as DeveloperTaskRecord;
  await db.send(new PutCommand({ TableName: "t", Item: task }));
  const logs: Array<Record<string, unknown>> = [];
  const startedWrites: unknown[] = [];
  const deps = {
    documentClient: db, tableName: "t", orgId: "org-1", now: () => Date.parse(NOW), log: (entry: Record<string, unknown>) => { logs.push(entry); },
    actions: {
      projectRevision: async () => ({ definition: definition(Object.hasOwn(options, "specTarget") ? options.specTarget : target(), options.withMeta ?? true) }),
      readArtifact: async () => PLAN_TEXT,
      workspace: async () => ({ status: "READY" }),
      acceptTask: async (...args: unknown[]) => { startedWrites.push(args); return { operation: {}, duplicate: false }; },
    },
    ...(options.readMetaFile === undefined ? {} : { readMetaFile: options.readMetaFile }),
  } as unknown as DeveloperTaskRouteDependencies;
  return { db, deps, task, logs, startedWrites, store: dynamoSpecStore({ documentClient: db, tableName: "t" }) };
}

describe("a person approves the plan", () => {
  it("records that a spec is due, with the target and the meta commit as they are now", async () => {
    const t = await setup();
    await specAfterPlanApproval(t.deps, TASK);
    expect((await t.store.load(TASK)).state).toMatchObject({ status: "due", planDigest: PLAN_DIGEST, knowledgeCommit: BASE, kind: "feature", target: { format: "kiro", where: "meta_repo" } });
  });
  it("does nothing for a project with no spec target, an unapproved plan, or the broker's own decision", async () => {
    for (const options of [{ specTarget: undefined }, { approved: "none" as const }, { approved: "agentx" as const }]) {
      const t = await setup(options);
      await specAfterPlanApproval(t.deps, TASK);
      expect((await t.store.load(TASK)).state, JSON.stringify(options)).toBeUndefined();
    }
  });
  it("records a failure the owner can continue past when the task has no meta commit or the project no meta repo, and never throws", async () => {
    const t = await setup({ knowledgeCommit: undefined });
    await specAfterPlanApproval(t.deps, TASK);
    expect((await t.store.load(TASK)).state).toMatchObject({ status: "failed", failure: { code: "unsupported" } });
    await expect(specAfterPlanApproval({ ...t.deps, actions: { ...t.deps.actions, projectRevision: async () => { throw new Error("down"); } } }, TASK)).resolves.toBeUndefined();
  });
  it("leaves the existing state alone when the same plan is approved again", async () => {
    const t = await setup();
    await specAfterPlanApproval(t.deps, TASK);
    const first = (await t.store.load(TASK)).state!;
    await specAfterPlanApproval(t.deps, TASK);
    expect((await t.store.load(TASK)).state!.revision).toBe(first.revision);
  });
});

function publishedState(overrides: Partial<SpecTarget> = {}, files: SpecFile[] = kiroFiles()): SpecState {
  let state = startWriting(newSpecState({ taskId: TASK, planDigest: PLAN_DIGEST, kind: "feature", target: target(overrides), knowledgeCommit: BASE, now: NOW }), randomUUID(), NOW)!;
  state = writeSucceeded(state, { operationId: state.writeOperationId!, title: "Reset", files, requirementCount: 2 }, NOW)!;
  return publishSucceeded(state, { pullRequest: { number: 12, url: `${META}/pull/12`, repositoryUrl: META, headBranch: `agentx/${randomUUID()}`, commit: SPEC_COMMIT } }, NOW)!;
}
function kiroFiles(): SpecFile[] {
  const draft = { version: 1, kind: "feature", title: "Reset password", summary: "s", planDigest: PLAN_DIGEST, requirements: [{ title: "r", criteria: [{ when: "a user asks", shall: "send a link" }, { shall: "log no password" }] }], design: "", tasks: [] };
  return kiroRenderer.render({ draft: draft as never, target: target(), taskKey: "t", existingFolders: [] }).files;
}

describe("the code pull request", () => {
  it("goes on at once for a task with no spec", async () => {
    const t = await setup({ specTarget: undefined });
    expect(await specPublicationGate(t.deps, t.task, t.task.workflow!)).toEqual({ proceed: true });
  });
  it("carries the link to a published spec, and waits for approval under spec_first", async () => {
    const t = await setup();
    await t.store.save(publishedState(), undefined);
    expect(await specPublicationGate(t.deps, t.task, t.task.workflow!)).toEqual({ proceed: true, linkLine: `Spec: ${META}/pull/12 @ ${SPEC_COMMIT}` });
    const first = await setup({ specTarget: target({ linkStyle: "spec_first" }) });
    await first.store.save(publishedState({ linkStyle: "spec_first" }), undefined);
    expect(await specPublicationGate(first.deps, first.task, first.task.workflow!)).toMatchObject({ proceed: false, hold: { reason: "waiting_approval" } });
  });
  it("starts the spec write for a due spec, from the approved plan, and holds meanwhile", async () => {
    const t = await setup();
    await specAfterPlanApproval(t.deps, TASK);
    const gate = await specPublicationGate(t.deps, t.task, t.task.workflow!);
    expect(gate).toMatchObject({ proceed: false, hold: { reason: "writing" } });
    expect(t.startedWrites).toHaveLength(1);
    const [, , request, , options] = t.startedWrites[0] as [unknown, unknown, { prompt: string }, unknown, { workflowMode: string; specWrite: { planDigest: string } }];
    expect(request.prompt).toContain(PLAN_TEXT);
    expect(options).toMatchObject({ workflowMode: "SPEC_WRITE", specWrite: { format: "kiro", kind: "feature", planDigest: PLAN_DIGEST } });
  });
  it("holds, never goes on, when the record cannot be read or the check itself fails", async () => {
    const t = await setup();
    await t.db.send(new PutCommand({ TableName: "t", Item: { pk: `DEVTASK#${TASK}`, sk: "SPEC#STATE", nonsense: true } }));
    expect(await specPublicationGate(t.deps, t.task, t.task.workflow!)).toMatchObject({ proceed: false, hold: { reason: "failed", ownerActions: ["continue_without_spec"] } });
    const broken = { ...t.deps, documentClient: { send: async () => { throw new Error("down"); } } } as never;
    expect(await specPublicationGate(broken, t.task, t.task.workflow!)).toMatchObject({ proceed: false });
  });
});

describe("the code review", () => {
  const readsFrom = (files: SpecFile[], seen: string[] = []) => async (_task: DeveloperTaskRecord, _url: string, path: string, commit: string) => { seen.push(`${path}@${commit}`); return files.find((file) => file.path === path)?.content; };
  it("goes on at once, with no spec to walk, for a task with no spec", async () => {
    const t = await setup({ specTarget: undefined });
    expect(await specReviewGate(t.deps, t.task, t.task.workflow!)).toEqual({ proceed: true });
  });
  it("is given the requirements read from the meta repo at the commit recorded when the spec was published", async () => {
    const seen: string[] = [];
    const t = await setup({ readMetaFile: readsFrom(kiroFiles(), seen) });
    await t.store.save(publishedState(), undefined);
    const gate = await specReviewGate(t.deps, t.task, t.task.workflow!);
    expect(gate).toMatchObject({ proceed: true, input: { specCommit: SPEC_COMMIT, specPath: ".kiro/specs/reset-password/", truncated: false } });
    expect(gate.proceed && gate.input!.requirements.map((requirement) => requirement.id)).toEqual(["1.1", "1.2"]);
    expect(seen.length).toBe(3);
    expect(seen.every((entry) => entry.endsWith(`@${SPEC_COMMIT}`))).toBe(true);
  });
  it("reads what the spec says now at that commit, so an edit a person made and the owner kept is what the review walks", async () => {
    const edited = kiroFiles().map((file) => file.path.endsWith("requirements.md") ? { ...file, content: `${file.content}- 1.3 WHEN a link is reused THE SYSTEM SHALL refuse it\n` } : file);
    const t = await setup({ readMetaFile: readsFrom(edited) });
    await t.store.save(publishedState(), undefined);
    const gate = await specReviewGate(t.deps, t.task, t.task.workflow!);
    expect(gate.proceed && gate.input!.requirements.map((requirement) => requirement.id)).toEqual(["1.1", "1.2", "1.3"]);
  });
  it("is held, never started without its spec, when the spec cannot be read, has no requirements left, or the reader is missing", async () => {
    for (const [name, readMetaFile] of [["unreadable", async () => undefined], ["empty", async (_t: unknown, _u: string, path: string) => kiroFiles().find((file) => file.path === path)?.content.replaceAll("SHALL", "may")], ["no reader", undefined]] as const) {
      const t = await setup({ readMetaFile: readMetaFile as never });
      await t.store.save(publishedState(), undefined);
      expect(await specReviewGate(t.deps, t.task, t.task.workflow!), name).toMatchObject({ proceed: false, hold: { reason: "failed" } });
    }
  });
  it("does not wait for approval of a spec_first spec: the review needs it published, the code pull request needs it approved", async () => {
    const t = await setup({ specTarget: target({ linkStyle: "spec_first" }), readMetaFile: readsFrom(kiroFiles()) });
    await t.store.save(publishedState({ linkStyle: "spec_first" }), undefined);
    expect(await specReviewGate(t.deps, t.task, t.task.workflow!)).toMatchObject({ proceed: true, input: { specCommit: SPEC_COMMIT } });
  });
  it("walks nothing for a spec the owner continued past", async () => {
    const t = await setup({ readMetaFile: vi.fn() as never });
    const { continueWithoutSpec } = await import("../../packages/broker/src/spec/state.js");
    await t.store.save(continueWithoutSpec(publishedState(), "owner", NOW)!, undefined);
    expect(await specReviewGate(t.deps, t.task, t.task.workflow!)).toEqual({ proceed: true });
  });
});

describe("the owner's choice", () => {
  it("is refused when it is not the owner who asks", async () => {
    const t = await setup();
    await t.store.save(publishedState(), undefined);
    const stranger = { developerId: "nobody", orgId: "org-1", orgRole: "member" } as never;
    await expect(specOwnerChoice({ ...t.deps, checkAccess: async () => { throw new Error("no access"); } }, stranger, TASK, "continue_without_spec")).rejects.toThrow();
    expect((await t.store.load(TASK)).state!.continuedWithoutSpec).toBeUndefined();
  });
});

describe("making the waiting step due again when the spec is ready", () => {
  const rowFor = async (stage: string, state: string) => {
    const t = await setup();
    await t.db.send(new PutCommand({ TableName: "t", Item: { ...t.task, workflow: { ...t.task.workflow, stage, state, candidate: { digest: "d".repeat(64) } } } }));
    return specEndEnvironmentOf({ documentClient: t.db, tableName: "t" } as never, WORKSPACE).republishItem(TASK);
  };
  it("queues the review for a task waiting at its review, and the code pull request for one ready to publish", async () => {
    expect((await rowFor("REVIEW", "WAITING"))?.Put?.Item).toMatchObject({ taskId: TASK, kind: "REVIEW", candidateDigest: "d".repeat(64), workflowRevision: 4 });
    expect((await rowFor("PULL_REQUEST", "READY"))?.Put?.Item).toMatchObject({ taskId: TASK, kind: "PUBLISH" });
  });
  it("queues nothing for a task that is running something else or has no candidate", async () => {
    expect(await rowFor("IMPLEMENT", "RUNNING")).toBeUndefined();
    expect(await rowFor("REVIEW", "RUNNING")).toBeUndefined();
  });
});
