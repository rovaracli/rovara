// Rovara Code (Plan 6 Task 19): a project's code settings. A maintainer reads and changes them; turning self-approval on waits for an organization owner or admin on the confirmation
// page, and everything else applies at once under the revision the caller read.
import { describe, expect, it } from "vitest";
import { CODE_SETTINGS_STALE_MESSAGE, DEFAULT_CODE_SETTINGS, NeedsConfirmationSchema, agentXError, codeSettingsKey, type OrgRole } from "../../packages/contracts/src/index.js";
import { getAnyApproval, getApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { changeTitleOf } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { getCodeSettings, putCodeSettings, readCodeSettings, type CodeSettingsDependencies } from "../../packages/broker/src/rovara-code/code-settings.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, PRIYA, ZED } from "../support/agent-session-world.js";
import { readChanges } from "../../packages/broker/src/realtime/changes.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
function settingsDeps(w: MergeWorld): CodeSettingsDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const put = (w: MergeWorld, who: string, body: Record<string, unknown>, project = "web") =>
  putCodeSettings(settingsDeps(w), w.caller(who), project, { requestId: w.requestId(), expectedRevision: 0, ...body }, w.deps);
const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const stored = (w: MergeWorld) => w.db.get(codeSettingsKey(ORG_A, "web")) as Record<string, unknown> | undefined;
const live = (w: MergeWorld, project = "web") => readCodeSettings({ documentClient: w.db, tableName: "state" }, ORG_A, project);

describe("reading a project's code settings", () => {
  it("answers the defaults for a project that has none, to anyone who can see the project", async () => {
    const w = mergeWorld();
    expect(await getCodeSettings(settingsDeps(w), w.caller(PRIYA), "web")).toEqual({ settings: DEFAULT_CODE_SETTINGS });
    expect(await getCodeSettings(settingsDeps(w), w.caller(MIA), "web")).toEqual({ settings: DEFAULT_CODE_SETTINGS });
  });

  it("answers what was saved, and the same project not found for someone with no role in it", async () => {
    const w = mergeWorld({ allowSelfApproval: true, mergeMethod: "merge" });
    expect(await getCodeSettings(settingsDeps(w), w.caller(PRIYA), "web")).toEqual({ settings: { allowSelfApproval: true, mergeMethod: "merge", codeReviewers: [], revision: 1 } });
    expect(await codeOf(getCodeSettings(settingsDeps(w), w.caller(ZED), "web"))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});

describe("changing the settings that apply at once", () => {
  it("applies the merge method and the reviewers under the revision read, and bumps the revision", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { mergeMethod: "merge", codeReviewers: ["alice", "acme/core"] });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ settings: { allowSelfApproval: false, mergeMethod: "merge", codeReviewers: ["alice", "acme/core"], revision: 1 } });
    expect(await live(w)).toEqual({ allowSelfApproval: false, mergeMethod: "merge", codeReviewers: ["alice", "acme/core"], revision: 1 });
    // The next change must name the revision it read.
    expect(await codeOf(put(w, MAX, { mergeMethod: "squash" }))).toEqual({ code: "CONFIG_INVALID", message: CODE_SETTINGS_STALE_MESSAGE });
    expect((await put(w, MAX, { mergeMethod: "squash", expectedRevision: 1 })).statusCode).toBe(200);
    expect((await live(w)).revision).toBe(2);
  });

  it("refuses a stale revision with the exact words and writes nothing", async () => {
    const w = mergeWorld({ mergeMethod: "squash" });
    expect(await codeOf(put(w, MAX, { mergeMethod: "merge", expectedRevision: 0 }))).toEqual({ code: "CONFIG_INVALID", message: "Someone changed these settings. Reload and try again." });
    expect((await live(w)).mergeMethod).toBe("squash");
    expect((await live(w)).revision).toBe(1);
  });

  it("turns self-approval off at once", async () => {
    const w = mergeWorld({ allowSelfApproval: true });
    const reply = await put(w, MAX, { allowSelfApproval: false, expectedRevision: 1 });
    expect(reply.statusCode).toBe(200);
    expect((await live(w)).allowSelfApproval).toBe(false);
  });

  it("answers a repeat of the same request with the same settings and does not change them twice", async () => {
    const w = mergeWorld();
    const requestId = w.requestId();
    const body = { requestId, expectedRevision: 0, mergeMethod: "merge" };
    const first = await putCodeSettings(settingsDeps(w), w.caller(MAX), "web", body, w.deps);
    const again = await putCodeSettings(settingsDeps(w), w.caller(MAX), "web", body, w.deps);
    expect(again.statusCode).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await live(w)).revision).toBe(1);
    // The same id with another body is another request, and is refused.
    expect(await codeOf(putCodeSettings(settingsDeps(w), w.caller(MAX), "web", { ...body, mergeMethod: "squash" }, w.deps))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not take another request for a repeat just because it asks for the same", async () => {
    const w = mergeWorld();
    expect((await put(w, MAX, { mergeMethod: "merge" })).statusCode).toBe(200);
    // Another request id, the same wish, the revision the first one read: the settings moved under it.
    expect(await codeOf(put(w, MAX, { mergeMethod: "merge", expectedRevision: 0 }))).toEqual({ code: "CONFIG_INVALID", message: CODE_SETTINGS_STALE_MESSAGE });
  });

  it("changes nothing for a self-approval setting that is already the way it is asked", async () => {
    const w = mergeWorld({ allowSelfApproval: true });
    const reply = await put(w, MAX, { allowSelfApproval: true, expectedRevision: 1 });
    expect(reply.statusCode).toBe(200);
    expect((await live(w)).revision).toBe(1);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });

  it("refuses a contributor, a viewer, and someone with no role, and a body that is not these settings", async () => {
    const w = mergeWorld();
    expect(await codeOf(put(w, ARJUN, { mergeMethod: "merge" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await codeOf(put(w, MIA, { mergeMethod: "merge" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await codeOf(put(w, ZED, { mergeMethod: "merge" }))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await codeOf(put(w, MAX, { payer: "x" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await codeOf(put(w, MAX, { mergeMethod: "rebase" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await codeOf(put(w, MAX, { codeReviewers: ["not a name"] }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await codeOf(put(w, MAX, { codeReviewers: Array.from({ length: 11 }, (_, index) => `reviewer${String(index)}`) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await codeOf(put(w, MAX, {}))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(stored(w)).toBeUndefined();
  });

  it("lets an organization admin change them without a project grant", async () => {
    const w = mergeWorld();
    expect((await put(w, OLA, { mergeMethod: "merge" })).statusCode).toBe(200);
  });
});

describe("turning self-approval on", () => {
  it("answers 202 NEEDS_CONFIRMATION with a link, changes nothing, and records one pending change bound to the revision", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { allowSelfApproval: true });
    expect(reply.statusCode).toBe(202);
    const body = NeedsConfirmationSchema.parse(reply.body);
    expect(body.confirmUrl.startsWith("https://")).toBe(true);
    expect(body.changes).toEqual(["Let a person approve a pull request that Rovara made for them, in project web"]);
    expect(await live(w)).toEqual(DEFAULT_CODE_SETTINGS);
    expect(await w.approvalOf(body.confirmUrl)).toMatchObject({
      kind: "change", status: "PENDING", requestedBy: MAX,
      subject: { kind: "code_settings", project: "web", settingsRevision: 0, changes: { allowSelfApproval: true } },
      approvers: { kind: "rule", rule: "org_admin" },
    });
  });

  it("is decided by an organization owner or admin only, never by the maintainer who asked", async () => {
    const w = mergeWorld();
    const body = NeedsConfirmationSchema.parse((await put(w, MAX, { allowSelfApproval: true })).body);
    const approvalId = w.approvalIdOf(body.confirmUrl);
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: MAX, approvalId })).toEqual({ status: "forbidden", who: "an organization owner or admin" });
    const refused = await w.decide(approvalId, await w.browser(MAX, approvalId));
    expect(refused.statusCode).toBe(403);
    expect(await live(w)).toEqual(DEFAULT_CODE_SETTINGS);
    const open = await w.kind.inspect({ orgId: ORG_A, developerId: OLA, approvalId });
    expect(open).toMatchObject({ status: "open", view: { title: changeTitleOf("code_settings") } });
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))?.status).toBe("APPROVED_DONE");
    expect(await live(w)).toEqual({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 });
  });

  it("lets an organization admin who is also the maintainer decide their own request", async () => {
    const w = mergeWorld();
    const body = NeedsConfirmationSchema.parse((await put(w, OLA, { allowSelfApproval: true })).body);
    const approvalId = w.approvalIdOf(body.confirmUrl);
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    expect((await live(w)).allowSelfApproval).toBe(true);
  });

  it("ends the change failed with the stale words when the settings changed after it was asked, and applies nothing", async () => {
    const w = mergeWorld();
    const body = NeedsConfirmationSchema.parse((await put(w, MAX, { allowSelfApproval: true })).body);
    const approvalId = w.approvalIdOf(body.confirmUrl);
    await put(w, MAX, { mergeMethod: "merge" });
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    expect(await getAnyApproval(w.deps, ORG_A, approvalId)).toMatchObject({ status: "APPROVED_FAILED", failure: CODE_SETTINGS_STALE_MESSAGE });
    expect((await live(w)).allowSelfApproval).toBe(false);
  });

  it("applies the other settings of the same request at once, and waits only for self-approval", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { allowSelfApproval: true, mergeMethod: "merge" });
    expect(reply.statusCode).toBe(202);
    expect(await live(w)).toEqual({ allowSelfApproval: false, mergeMethod: "merge", codeReviewers: [], revision: 1 });
    const approvalId = w.approvalIdOf(NeedsConfirmationSchema.parse(reply.body).confirmUrl);
    expect(await getAnyApproval(w.deps, ORG_A, approvalId)).toMatchObject({ subject: { settingsRevision: 1 } });
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    expect(await live(w)).toEqual({ allowSelfApproval: true, mergeMethod: "merge", codeReviewers: [], revision: 2 });
  });

  it("answers a repeat of the same request with the same change and does not change the other settings twice", async () => {
    const w = mergeWorld();
    const body = { requestId: w.requestId(), expectedRevision: 0, allowSelfApproval: true, mergeMethod: "merge" };
    const first = await putCodeSettings(settingsDeps(w), w.caller(MAX), "web", body, w.deps);
    const again = await putCodeSettings(settingsDeps(w), w.caller(MAX), "web", body, w.deps);
    expect(w.approvalIdOf(NeedsConfirmationSchema.parse(again.body).confirmUrl)).toBe(w.approvalIdOf(NeedsConfirmationSchema.parse(first.body).confirmUrl));
    expect((await live(w)).revision).toBe(1);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
  });

  it("tells a request that was declined, and asked again, that it was decided", async () => {
    const w = mergeWorld();
    const body = { requestId: w.requestId(), expectedRevision: 0, allowSelfApproval: true };
    const first = await putCodeSettings(settingsDeps(w), w.caller(MAX), "web", body, w.deps);
    const approvalId = w.approvalIdOf(NeedsConfirmationSchema.parse(first.body).confirmUrl);
    await w.decide(approvalId, await w.browser(OLA, approvalId), "decline");
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))?.status).toBe("DECLINED");
    expect(await codeOf(putCodeSettings(settingsDeps(w), w.caller(MAX), "web", body, w.deps))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(await live(w)).toEqual(DEFAULT_CODE_SETTINGS);
  });

  it("applies to the project it was asked for, and to no other", async () => {
    // `web` has settings at revision 1; `ops` has none, so a change read from the wrong project would find the wrong revision.
    const w = mergeWorld({ mergeMethod: "merge" });
    const reply = await put(w, OLA, { allowSelfApproval: true, expectedRevision: 0 }, "ops");
    const approvalId = w.approvalIdOf(NeedsConfirmationSchema.parse(reply.body).confirmUrl);
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    expect(await live(w, "ops")).toEqual({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 });
    expect(await live(w)).toEqual({ allowSelfApproval: false, mergeMethod: "merge", codeReviewers: [], revision: 1 });
  });

  it("never applies a change nobody decided", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { allowSelfApproval: true });
    const record = await getAnyApproval(w.deps, ORG_A, w.approvalIdOf(NeedsConfirmationSchema.parse(reply.body).confirmUrl));
    await expect(getApprovalSubjectHandler("code_settings")!(w.deps, record!)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await live(w)).toEqual(DEFAULT_CODE_SETTINGS);
  });

  it("is not available where no confirmation page is set up", async () => {
    const w = mergeWorld();
    expect(await codeOf(putCodeSettings(settingsDeps(w), w.caller(MAX), "web", { requestId: w.requestId(), expectedRevision: 0, allowSelfApproval: true }, undefined))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await live(w)).toEqual(DEFAULT_CODE_SETTINGS);
  });
});

describe("what a settings change leaves behind", () => {
  it("records a change that applies at once in the Audit Ledger, with words and counts only", async () => {
    const w = mergeWorld();
    await put(w, MAX, { mergeMethod: "merge", codeReviewers: ["alice", "acme/core"] });
    const [event] = w.audit.recordedBy("code_settings.changed");
    expect(event).toMatchObject({ action: "code_settings.changed", actor: { kind: "member", id: MAX }, facts: { revision: 1, changed: "mergeMethod,codeReviewers", mergeMethod: "merge", reviewers: 2, selfApproval: false } });
    expect(JSON.stringify(event)).not.toContain("alice");
    // The fact commits with the change: it is in the same transaction.
    const written = w.db.transactions().find((items) => items.some((entry) => JSON.stringify(entry).includes("CODE_SETTINGS")))!;
    expect(JSON.stringify(written)).toContain("AUDIT_PENDING");
  });

  it("records self-approval turned on by the administrator who confirmed it, with the page's proof", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { allowSelfApproval: true });
    const approvalId = w.approvalIdOf(NeedsConfirmationSchema.parse(reply.body).confirmUrl);
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    const events = w.audit.recordedBy("code_settings.changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: OLA }, facts: { revision: 1, changed: "selfApproval", selfApproval: true }, related: [approvalId], proof: { kind: "fresh_sign_in" } });
    const written = w.db.transactions().filter((items) => items.some((entry) => JSON.stringify(entry).includes("selfApprovalConfirmedBy"))).at(-1)!;
    expect(JSON.stringify(written)).toContain("AUDIT_PENDING");
    expect(JSON.stringify(written)).toContain("CHANGE_NOTICE");
  });

  it("records nothing when nothing changed", async () => {
    const w = mergeWorld({ allowSelfApproval: true });
    await put(w, MAX, { allowSelfApproval: true, expectedRevision: 1 });
    expect(w.audit.recordedBy("code_settings.changed")).toEqual([]);
  });

  it("tells the project's other maintainers, once it applies, with a notice that holds ids and a revision only", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { allowSelfApproval: true });
    const approvalId = w.approvalIdOf(NeedsConfirmationSchema.parse(reply.body).confirmUrl);
    expect(await readChanges({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: MAX }, undefined)).toMatchObject({ notices: [] });
    await w.decide(approvalId, await w.browser(OLA, approvalId));
    w.clock.now += 1000;
    const told = await readChanges({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: MAX }, undefined);
    expect(told.notices).toHaveLength(1);
    expect(told.notices[0]).toMatchObject({ type: "code_settings.changed", project: "web", revision: 1, by: OLA });
    // The administrator who decided it is not told of their own decision, and a contributor is not told at all.
    expect((await readChanges({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: OLA }, undefined)).notices).toEqual([]);
    expect((await readChanges({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: PRIYA }, undefined)).notices).toEqual([]);
  });

  it("refuses the same reviewer twice, whatever the case", async () => {
    const w = mergeWorld();
    expect(await codeOf(put(w, MAX, { codeReviewers: ["alice", "Alice"] }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("what the page says", () => {
  it("names the two kinds of change in words", () => {
    expect(changeTitleOf("code_settings")).toBe("Let people approve their own pull requests");
    expect(changeTitleOf("pull_request_merge")).toBe("Merge a pull request");
  });
});
