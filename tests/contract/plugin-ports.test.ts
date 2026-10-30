import { describe, expect, it } from "vitest";
import {
  ActingIdentityPolicySchema, AttributionSchema, ChangeRequestFeedbackSchema, ChangeRequestInputSchema, ChangeRequestStatusSchema, ChangeRequestUpdateSchema, CheckSchema,
  CheckStartRequestSchema, CheckTargetSchema, CodeHostCapabilitiesSchema, CodeHostEventSchema, CODE_HOST_EVENT_TYPES, DelegatedGrantSchema, GitCredentialSchema,
  HostScopeSchema, MergeResultSchema, PluginKindSchema, TrackerEventSchema, TrackerItemSchema, actingIdentityModeAllowed, delegatedUseAllowed,
} from "../../packages/contracts/src/plugins/index.js";

const ref = { repository: { url: "https://git.example.test/acme/app" }, id: "7", url: "https://git.example.test/acme/app/pull/7" };
const sha = "a".repeat(40);
const hex64 = "b".repeat(64);

describe("plug-in kinds and scopes", () => {
  it.each(["github", "fake", "code-commit", "x1"])("accepts the kind %s", (kind) => expect(PluginKindSchema.safeParse(kind).success).toBe(true));
  it.each(["", "GitHub", "has space", "1abc", "a".repeat(33), "../x", "git_hub"])("refuses the kind %j", (kind) => expect(PluginKindSchema.safeParse(kind).success).toBe(false));

  it("takes an org scope or a named system scope and nothing else", () => {
    expect(HostScopeSchema.safeParse({ system: "webhook" }).success).toBe(true);
    expect(HostScopeSchema.safeParse({ system: "anything" }).success).toBe(false);
    expect(HostScopeSchema.safeParse({}).success).toBe(false);
    expect(HostScopeSchema.safeParse({ system: "webhook", orgId: "x" }).success).toBe(false);
  });
});

describe("code host capabilities", () => {
  const caps = { drafts: true, threadedComments: true, requiredApprovals: true, codeOwners: true, webhooks: true, rerunChecks: false, perPersonCredentials: false, merge: true, markReady: true, requestReviewers: true, credentialKinds: ["token"] };
  it("accepts a full set", () => expect(CodeHostCapabilitiesSchema.parse(caps)).toEqual(caps));
  it("refuses a missing capability, an extra one and an empty credential list", () => {
    const missing: Record<string, unknown> = { ...caps };
    delete missing.drafts;
    expect(CodeHostCapabilitiesSchema.safeParse(missing).success).toBe(false);
    expect(CodeHostCapabilitiesSchema.safeParse({ ...caps, extra: true }).success).toBe(false);
    expect(CodeHostCapabilitiesSchema.safeParse({ ...caps, credentialKinds: [] }).success).toBe(false);
    expect(CodeHostCapabilitiesSchema.safeParse({ ...caps, credentialKinds: ["password"] }).success).toBe(false);
  });
});

describe("git credentials", () => {
  it("takes each of the four kinds with its own fields", () => {
    expect(GitCredentialSchema.safeParse({ kind: "token", token: "t" }).success).toBe(true);
    expect(GitCredentialSchema.safeParse({ kind: "basic", username: "u", password: "p" }).success).toBe(true);
    expect(GitCredentialSchema.safeParse({ kind: "ssh-key", privateKey: "k" }).success).toBe(true);
    expect(GitCredentialSchema.safeParse({ kind: "helper", helper: "h" }).success).toBe(true);
  });
  it("refuses a kind with another kind's field, an empty secret and an unknown kind", () => {
    expect(GitCredentialSchema.safeParse({ kind: "token", password: "p" }).success).toBe(false);
    expect(GitCredentialSchema.safeParse({ kind: "token", token: "" }).success).toBe(false);
    expect(GitCredentialSchema.safeParse({ kind: "cookie", token: "t" }).success).toBe(false);
  });
});

describe("change requests", () => {
  it("accepts an input and refuses an empty title, a missing branch and unknown fields", () => {
    const input = { repository: { url: "https://git.example.test/acme/app" }, sourceBranch: "rovara/x", targetBranch: "main", title: "Fix" };
    expect(ChangeRequestInputSchema.safeParse(input).success).toBe(true);
    expect(ChangeRequestInputSchema.safeParse({ ...input, title: "" }).success).toBe(false);
    expect(ChangeRequestInputSchema.safeParse({ ...input, sourceBranch: "" }).success).toBe(false);
    expect(ChangeRequestInputSchema.safeParse({ ...input, sourceBranch: "a\u0007b" }).success).toBe(false);
    expect(ChangeRequestInputSchema.safeParse({ ...input, sneaky: 1 }).success).toBe(false);
  });

  it("refuses a link that is not https or carries credentials", () => {
    expect(ChangeRequestUpdateSchema.safeParse({}).success).toBe(false);
    expect(ChangeRequestUpdateSchema.safeParse({ state: "merged" }).success).toBe(false);
    expect(ChangeRequestUpdateSchema.safeParse({ title: "x", state: "closed" }).success).toBe(true);
    const base = { name: "ci", state: "pending", required: true };
    expect(CheckSchema.safeParse({ ...base, url: "http://x.test/1" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, url: "https://user:pw@x.test/1" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, url: "javascript:alert(1)" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, url: "" }).success).toBe(true);
  });

  it("never reads a finished check without a conclusion as a pass, nor a pending one with a conclusion", () => {
    const base = { name: "ci", required: false, url: "" };
    expect(CheckSchema.safeParse({ ...base, state: "completed" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, state: "completed", conclusion: "success" }).success).toBe(true);
    expect(CheckSchema.safeParse({ ...base, state: "pending", conclusion: "success" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, state: "completed", conclusion: "great" }).success).toBe(false);
  });

  it("parses a status with checks, required checks and reviews", () => {
    const status = {
      id: "7", state: "open", draft: false, headRevision: sha, targetBranch: "main", mergeableState: "clean", mergeable: true,
      checks: [{ name: "ci", state: "completed", conclusion: "success", required: true, url: "" }], requiredChecks: [{ name: "ci" }], targetHasRequiredChecks: true,
      headDefinesChecks: true, requestedReviewers: 0,
      reviews: [{ reviewer: { login: "pat" }, accountType: "User", state: "APPROVED", revision: sha, submittedAt: "2026-10-30T00:00:00Z" }],
    };
    expect(ChangeRequestStatusSchema.parse(status)).toEqual(status);
    expect(ChangeRequestStatusSchema.safeParse({ ...status, mergeableState: "fine" }).success).toBe(false);
    expect(ChangeRequestStatusSchema.safeParse({ ...status, reviews: [{ ...status.reviews[0], state: "LGTM" }] }).success).toBe(false);
  });

  it("parses feedback with a head tree and refuses one without", () => {
    const details = { ref, state: "open", sourceBranch: "b", targetBranch: "main", headRevision: sha, title: "t", body: "" };
    const feedback = { changeRequest: { ...details, headTreeRevision: sha }, comments: [{ id: "1", kind: "discussion", url: "", author: "pat", updatedAt: "2026-10-30T00:00:00Z", body: "hi" }], threads: [] };
    expect(ChangeRequestFeedbackSchema.safeParse(feedback).success).toBe(true);
    expect(ChangeRequestFeedbackSchema.safeParse({ ...feedback, changeRequest: details }).success).toBe(false);
  });

  it("types a merge result by outcome with fixed refusal reasons", () => {
    expect(MergeResultSchema.safeParse({ outcome: "merged", method: "squash", fellBack: false }).success).toBe(true);
    expect(MergeResultSchema.safeParse({ outcome: "already_merged" }).success).toBe(true);
    expect(MergeResultSchema.safeParse({ outcome: "refused", reason: "head_changed" }).success).toBe(true);
    expect(MergeResultSchema.safeParse({ outcome: "refused", reason: "because" }).success).toBe(false);
    expect(MergeResultSchema.safeParse({ outcome: "refused", reason: "closed", hostMessage: "x".repeat(201) }).success).toBe(false);
  });
});

describe("neutral events", () => {
  const base = { eventId: "d-1", host: "github" };
  it("covers the neutral event types of the design, and each parses", () => {
    expect([...CODE_HOST_EVENT_TYPES].sort()).toEqual(["change_request.closed", "change_request.merged", "change_request.opened", "change_request.updated", "check.completed", "comment.created", "review.submitted", "revision.pushed"]);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "change_request.opened", ref }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "review.submitted", ref, state: "APPROVED" }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "comment.created", ref, commentId: "9" }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "check.completed", repository: ref.repository, revision: sha, name: "ci", conclusion: "failure" }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "revision.pushed", repository: ref.repository, branch: "main", revision: sha }).success).toBe(true);
  });
  it("refuses an event with no delivery id, an unknown type or a field it does not know", () => {
    expect(CodeHostEventSchema.safeParse({ host: "github", type: "change_request.opened", ref }).success).toBe(false);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "repository.deleted", ref }).success).toBe(false);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "change_request.opened", ref, payload: {} }).success).toBe(false);
  });
});

describe("check runners and trackers", () => {
  it("takes a target by change request, revision or known run, and refuses a start with no idempotency key", () => {
    expect(CheckTargetSchema.safeParse({ kind: "change-request", ref }).success).toBe(true);
    expect(CheckTargetSchema.safeParse({ kind: "revision", repository: ref.repository, revision: sha }).success).toBe(true);
    expect(CheckTargetSchema.safeParse({ kind: "run", repository: ref.repository, revision: sha, run: { runner: "codebuild", id: "b:1" }, gate: "unit" }).success).toBe(true);
    expect(CheckTargetSchema.safeParse({ kind: "branch", name: "main" }).success).toBe(false);
    const start = { repository: ref.repository, revision: sha, gate: "unit", project: "p", timeoutMinutes: 20, idempotencyKey: "k" };
    expect(CheckStartRequestSchema.safeParse(start).success).toBe(true);
    expect(CheckStartRequestSchema.safeParse({ ...start, idempotencyKey: undefined }).success).toBe(false);
    expect(CheckStartRequestSchema.safeParse({ ...start, timeoutMinutes: 0 }).success).toBe(false);
  });

  it("parses a tracker item and the two events that can start a task", () => {
    const item = { ref: { tracker: "linear", id: "ENG-1" }, title: "t", body: "b", status: "open", labels: ["rovara"] };
    expect(TrackerItemSchema.safeParse(item).success).toBe(true);
    expect(TrackerItemSchema.safeParse({ ...item, status: "blocked" }).success).toBe(false);
    const base = { eventId: "e1", tracker: "linear", item: item.ref };
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.assigned_to_rovara" }).success).toBe(true);
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.labelled", label: "rovara" }).success).toBe(true);
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.labelled" }).success).toBe(false);
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.commented" }).success).toBe(false);
  });
});

describe("acting identity", () => {
  it("defaults nothing by itself but accepts only the two modes", () => {
    expect(ActingIdentityPolicySchema.safeParse({ plugin: "github", mode: "service" }).success).toBe(true);
    expect(ActingIdentityPolicySchema.safeParse({ plugin: "github", mode: "on-behalf-of" }).success).toBe(true);
    expect(ActingIdentityPolicySchema.safeParse({ plugin: "github", mode: "password" }).success).toBe(false);
  });

  it("offers on-behalf-of only where the host offers delegation", () => {
    expect(actingIdentityModeAllowed({ service: true, delegation: false }, "on-behalf-of")).toEqual({ ok: false, reason: "plugin_has_no_delegation" });
    expect(actingIdentityModeAllowed({ service: true, delegation: true }, "on-behalf-of")).toEqual({ ok: true, mode: "on-behalf-of" });
    expect(actingIdentityModeAllowed({ service: false, delegation: true }, "service")).toEqual({ ok: false, reason: "plugin_cannot_act_as_service" });
    expect(actingIdentityModeAllowed({ service: true, delegation: true }, "long-lived-cookie")).toEqual({ ok: false, reason: "mode_not_offered" });
  });

  it("names who asked and who approved in an attribution", () => {
    const attribution = { requestedBy: { name: "Priya", personId: hex64 }, approvedBy: { name: "Sam", personId: hex64 }, taskId: "task-1" };
    expect(AttributionSchema.safeParse(attribution).success).toBe(true);
    expect(AttributionSchema.safeParse({ ...attribution, requestedBy: { name: "Priya", personId: "short" } }).success).toBe(false);
    expect(AttributionSchema.safeParse({ approvedBy: attribution.approvedBy, taskId: "t" }).success).toBe(false);
  });

  it("lets a delegated credential serve only its own task's writes at its own plug-in before it expires", () => {
    const grant = DelegatedGrantSchema.parse({ plugin: "ghes", taskId: "t1", expiresAt: 2_000 });
    const use = { plugin: "ghes", taskId: "t1", purpose: "task-write", now: 1_000 };
    expect(delegatedUseAllowed(grant, use)).toEqual({ ok: true });
    expect(delegatedUseAllowed(grant, { ...use, purpose: "approve" })).toEqual({ ok: false, reason: "not_a_task_write" });
    expect(delegatedUseAllowed(grant, { ...use, purpose: "merge" })).toEqual({ ok: false, reason: "not_a_task_write" });
    expect(delegatedUseAllowed(grant, { ...use, taskId: "t2" })).toEqual({ ok: false, reason: "other_task" });
    expect(delegatedUseAllowed(grant, { ...use, plugin: "github" })).toEqual({ ok: false, reason: "other_plugin" });
    expect(delegatedUseAllowed(grant, { ...use, now: 2_000 })).toEqual({ ok: false, reason: "expired" });
    expect(delegatedUseAllowed(grant, { ...use, now: Number.NaN })).toEqual({ ok: false, reason: "expired" });
  });
});
