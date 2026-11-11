// Meta repo lane D (D4): people editing or approving the spec pull request. The facts are read from GitHub, never taken from the delivery.
import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { SpecTargetSchema, type SpecFile, type SpecTarget } from "@rovara-code/contracts";
import type { readSpecPullRequestOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { handleSpecPullRequestEvent } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { createSpecHooks, type SpecWorld } from "../../packages/broker/src/spec/hooks.js";
import { refreshSpecState, specStateFromFacts, type SpecPullRequestFacts } from "../../packages/broker/src/spec/refresh.js";
import { dynamoSpecStore } from "../../packages/broker/src/spec/store.js";
import { newSpecState, publishSucceeded, specPullRequestKey, startWriting, writeSucceeded, type SpecState } from "../../packages/broker/src/spec/state.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { fullStatus, specProjectItem } from "../support/spec-project.js";

const TASK = randomUUID();
const PLAN = "a".repeat(64);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const EDIT = "d".repeat(40);
const NOW = "2026-10-31T10:00:00.000Z";
const META = "https://github.com/acme/service-meta";
const FILES: SpecFile[] = [{ path: ".kiro/specs/x/requirements.md", content: "- 1.1 WHEN a THE SYSTEM SHALL b\n" }];
const target = (overrides: Partial<SpecTarget> = {}): SpecTarget => SpecTargetSchema.parse({ format: "kiro", ...overrides });

function published(overrides: Partial<SpecTarget> = {}): SpecState {
  let state = startWriting(newSpecState({ taskId: TASK, planDigest: PLAN, kind: "feature", target: target(overrides), knowledgeCommit: BASE, now: NOW }), randomUUID(), NOW)!;
  state = writeSucceeded(state, { operationId: state.writeOperationId!, title: "T", files: FILES, requirementCount: 1 }, NOW)!;
  return publishSucceeded(state, { pullRequest: { number: 12, url: `${META}/pull/12`, repositoryUrl: META, headBranch: `agentx/${randomUUID()}`, commit: HEAD } }, NOW)!;
}
const facts = (overrides: Partial<SpecPullRequestFacts> = {}): SpecPullRequestFacts => ({ state: "open", headSha: HEAD, reviews: [], ...overrides });
const approval = (overrides: Record<string, unknown> = {}) => ({ state: "APPROVED", commitId: HEAD, login: "reviewer", userId: "u-reviewer", eligible: true, ...overrides });

describe("what GitHub shows of the spec pull request", () => {
  it("changes nothing for the head Rovara pushed with no review", () => {
    expect(specStateFromFacts(published(), facts(), NOW)).toBeUndefined();
    expect(specStateFromFacts(published({ linkStyle: "spec_first" }), facts(), NOW)).toBeUndefined();
  });
  it("asks the owner when the head is not the recorded one, once for each new head", () => {
    const changed = specStateFromFacts(published(), facts({ headSha: EDIT }), NOW)!;
    expect(changed.editPrompt).toMatchObject({ headSha: EDIT, status: "open" });
    expect(specStateFromFacts(changed, facts({ headSha: EDIT }), NOW)).toBeUndefined();
    const second = specStateFromFacts({ ...changed, editPrompt: { ...changed.editPrompt!, status: "kept" } }, facts({ headSha: "e".repeat(40) }), NOW)!;
    expect(second.editPrompt).toMatchObject({ headSha: "e".repeat(40), status: "open" });
  });
  it("ignores a head that is not a commit id", () => {
    expect(specStateFromFacts(published(), facts({ headSha: "main" }), NOW)).toBeUndefined();
  });
  it("records an approval of the recorded head under spec_first, by the approver's login", () => {
    const next = specStateFromFacts(published({ linkStyle: "spec_first" }), facts({ reviews: [approval()] }), NOW)!;
    expect(next).toMatchObject({ approvedBy: "reviewer" });
    expect(next.approvedAt).toBe(NOW);
  });
  it("does not take an approval of another commit, a review that asks for changes, a comment, an incomplete list, or any approval when the target does not wait", () => {
    const first = published({ linkStyle: "spec_first" });
    expect(specStateFromFacts(first, facts({ reviews: [approval({ commitId: EDIT })] }), NOW)).toBeUndefined();
    expect(specStateFromFacts(first, facts({ reviews: [approval(), { state: "CHANGES_REQUESTED", commitId: HEAD, login: "other", userId: "u-other", eligible: true }] }), NOW)).toBeUndefined();
    expect(specStateFromFacts(first, facts({ reviews: [{ state: "COMMENTED", commitId: HEAD }, { state: "DISMISSED", commitId: HEAD }] }), NOW)).toBeUndefined();
    expect(specStateFromFacts(first, facts({ reviews: [approval()], reviewsIncomplete: true }), NOW)).toBeUndefined();
    expect(specStateFromFacts(published(), facts({ reviews: [approval()] }), NOW)).toBeUndefined();
  });
  it("takes a merge of the spec pull request as its approval", () => {
    expect(specStateFromFacts(published({ linkStyle: "spec_first" }), facts({ state: "merged" }), NOW)!.approvedAt).toBe(NOW);
  });
  it("fails the spec, with a fixed code the owner can continue past, when the pull request was closed without a merge", () => {
    const closed = specStateFromFacts(published(), facts({ state: "closed" }), NOW)!;
    expect(closed).toMatchObject({ status: "failed", failure: { code: "spec_closed" } });
  });
  it("withdraws an earlier approval when the spec is edited after it", () => {
    const approvedState = specStateFromFacts(published({ linkStyle: "spec_first" }), facts({ reviews: [approval()] }), NOW)!;
    const changed = specStateFromFacts(approvedState, facts({ headSha: EDIT, reviews: [approval()] }), NOW)!;
    expect(changed.approvedAt).toBeUndefined();
    expect(changed.editPrompt?.status).toBe("open");
  });
});

function memory() {
  const db = new FakeDynamoDb();
  const store = dynamoSpecStore({ documentClient: db, tableName: "t" });
  return { db, store };
}

describe("refreshing from GitHub", () => {
  it("stores the state that follows, and does nothing when GitHub cannot say", async () => {
    const { store } = memory();
    const state = published();
    await store.save(state, undefined);
    const env = (read: () => Promise<SpecPullRequestFacts | undefined>) => ({ store, now: () => NOW, read });
    expect(await refreshSpecState(env(async () => undefined), TASK)).toMatchObject({ changed: false });
    expect(await refreshSpecState(env(async () => { throw new Error("502"); }), TASK)).toMatchObject({ changed: false });
    expect((await store.load(TASK)).state!.revision).toBe(state.revision);
    const done = await refreshSpecState(env(async () => facts({ headSha: EDIT })), TASK);
    expect(done.changed).toBe(true);
    expect((await store.load(TASK)).state!.editPrompt?.headSha).toBe(EDIT);
    // The same facts again: nothing more.
    expect(await refreshSpecState(env(async () => facts({ headSha: EDIT })), TASK)).toMatchObject({ changed: false });
  });
  it("does not look at a spec that is not published, or that was continued past", async () => {
    const { store } = memory();
    const read = vi.fn(async () => facts({ headSha: EDIT }));
    await store.save(startWriting(newSpecState({ taskId: TASK, planDigest: PLAN, kind: "feature", target: target(), knowledgeCommit: BASE, now: NOW }), randomUUID(), NOW)!, undefined);
    await refreshSpecState({ store, now: () => NOW, read }, TASK);
    expect(read).not.toHaveBeenCalled();
  });
  it("leaves the state alone when another writer moved it first", async () => {
    const { store } = memory();
    const state = published();
    await store.save(state, undefined);
    const racing = { store: { load: (taskId: string) => store.load(taskId), save: async () => false, force: async () => false }, now: () => NOW, read: async () => facts({ headSha: EDIT }) };
    expect(await refreshSpecState(racing, TASK)).toMatchObject({ changed: false });
    expect((await store.load(TASK)).state!.editPrompt).toBeUndefined();
  });
});

describe("the gate looks at the spec pull request before it decides", () => {
  const world = (store: ReturnType<typeof memory>["store"], read: SpecWorld["readPullRequest"]): SpecWorld => ({
    tableName: "t", now: () => NOW, store, log: () => undefined, startWrite: async () => "BUSY", publish: async () => ({ ok: false, transient: true }), ...(read === undefined ? {} : { readPullRequest: read }),
  });
  const task = { taskId: TASK, title: "T", knowledgeCommit: BASE };
  const input = { task, approvedPlanDigest: PLAN, planMarkdown: () => "plan", metaRepositoryUrl: META };
  it("holds the code pull request when a person edited the spec, and releases a spec_first hold when it was approved", async () => {
    const { store } = memory();
    await store.save(published({ linkStyle: "spec_first" }), undefined);
    const waiting = await createSpecHooks(world(store, async () => facts())).gate(input);
    expect(waiting).toMatchObject({ proceed: false, hold: { reason: "waiting_approval" } });
    const released = await createSpecHooks(world(store, async () => facts({ reviews: [approval()] }))).gate(input);
    expect(released).toMatchObject({ proceed: true });
    const edited = await createSpecHooks(world(store, async () => facts({ headSha: EDIT, reviews: [approval()] }))).gate(input);
    expect(edited).toMatchObject({ proceed: false, hold: { reason: "edited", ownerActions: ["keep", "replan"] } });
  });
  it("is not changed by a GitHub that cannot be read: the recorded state decides", async () => {
    const { store } = memory();
    await store.save(published(), undefined);
    expect(await createSpecHooks(world(store, async () => { throw new Error("502"); })).gate(input)).toMatchObject({ proceed: true });
  });
});

describe("a GitHub delivery about a pull request", () => {
  async function setup(status: Awaited<ReturnType<NonNullable<ReturnType<typeof readSpecPullRequestOf>>>> | "throws") {
    const db = new FakeDynamoDb();
    const workspaceId = randomUUID();
    const state = published({ linkStyle: "spec_first" });
    await dynamoSpecStore({ documentClient: db, tableName: "t" }).save(state, undefined);
    await db.send(new PutCommand({ TableName: "t", Item: { ...specPullRequestKey("acme/service-meta", 12), entityType: "SPEC_PULL_REQUEST", taskId: TASK } }));
    await db.send(new PutCommand({ TableName: "t", Item: { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, workspaceId, project: "demo", startingRevision: 1, orgId: TEST_ORG, title: "T", workflow: undefined } }));
    db.set(specProjectItem(META));
    const getPullRequestStatus = vi.fn(async () => { if (status === "throws") throw new Error("502"); return fullStatus({ state: status!.state, headSha: status!.headSha, reviews: status!.reviews.map((review) => ({ state: review.state, commitId: review.commitId, login: review.login ?? "reviewer", githubUserId: review.userId ?? "u1", userType: "User" })) }) as never; });
    const getRepositoryPermission = vi.fn(async () => "write" as const);
    const dependencies = { documentClient: db, tableName: "t", githubPullRequests: { getPullRequestStatus, getRepositoryPermission } } as never;
    return { db, dependencies, getPullRequestStatus, store: dynamoSpecStore({ documentClient: db, tableName: "t" }) };
  }
  it("reads GitHub and records an approval of the spec pull request, for any pull request event", async () => {
    const { dependencies, store, getPullRequestStatus } = await setup(facts({ reviews: [approval()] }));
    await handleSpecPullRequestEvent(dependencies, { kind: "PULL_REQUEST", fullName: "Acme/Service-Meta", number: 12 });
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect((await store.load(TASK)).state!.approvedBy).toBe("reviewer");
  });
  it("records an edit and asks the owner", async () => {
    const { dependencies, store } = await setup(facts({ headSha: EDIT }));
    await handleSpecPullRequestEvent(dependencies, { kind: "PR_COMMENT", fullName: "acme/service-meta", number: 12 });
    expect((await store.load(TASK)).state!.editPrompt).toMatchObject({ headSha: EDIT, status: "open" });
  });
  it("costs nothing for another pull request or another kind of event, and never throws", async () => {
    const { dependencies, getPullRequestStatus } = await setup("throws");
    await handleSpecPullRequestEvent(dependencies, { kind: "PULL_REQUEST", fullName: "acme/service-meta", number: 99 });
    await handleSpecPullRequestEvent(dependencies, { kind: "HEAD_STATUS", fullName: "acme/service-meta", number: 12 });
    expect(getPullRequestStatus).not.toHaveBeenCalled();
    await expect(handleSpecPullRequestEvent(dependencies, { kind: "PULL_REQUEST", fullName: "acme/service-meta", number: 12 })).resolves.toBeUndefined();
  });
});
