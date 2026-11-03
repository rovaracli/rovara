// Design review stage DR8: the project's design review setting in How we work (the playbook's `designReview`), the company's stricter-only lock on it, and the audit event on change.
// The setting rides the existing playbook document and PUT (DR1 put the field on the schema and the body); this file pins what the broker does with it.
import { describe, expect, it } from "vitest";
import {
  DESIGN_REVIEW_DEFAULT_SETTING, ProjectPlaybookBodySchema, agentXError, designReviewSettingOf, editionPolicy, orgMetaKey, projectPlaybookKey, type DesignReviewSetting, type OrgRole,
} from "../../packages/contracts/src/index.js";
import { getProjectPlaybook, putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { readProjectPlaybook, readProjectPlaybookState, writeProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, DESIGN_REVIEW_LOCK_SK, DESIGN_REVIEW_LOCK_GROUP_EDITION, applyLock, checkDesignReviewLockWrite, effectiveDesignReviewSetting, lockViolations, type DesignReviewLock } from "../../packages/broker/src/design-review/lock.js";
import { isEffectiveSetting } from "../../packages/broker/src/design-review/effective-setting.js";
import { readEffectiveDesignReview } from "../../packages/broker/src/design-review/setting.js";
import { MAX, MIA, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
function playbookDeps(w: MergeWorld, extra: Partial<ProjectPlaybookDependencies> = {}): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps, edition: editionPolicy("enterprise"),
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
    // The people a setting may name (L4): without a list, naming anyone is refused, so the tests that save a named approver say who can approve.
    namedApproverCandidates: async () => [MAX, PRIYA, MIA, OLA, "secret-person-1", "secret-person-2", "me"],
    ...extra,
  };
}
const SETTING: DesignReviewSetting = { mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 25, highRiskApprover: { kind: "people", memberIds: ["secret-person-1", "secret-person-2"] } };
const put = (w: MergeWorld, who: string, body: Record<string, unknown>, extra: Partial<ProjectPlaybookDependencies> = {}) =>
  putProjectPlaybook(playbookDeps(w, extra), w.caller(who), "web", { expectedRevision: 0, defaultProcess: { kind: "builtin" }, ...body });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message.replace(`${String(error.code)}: `, "") }));
const stored = (w: MergeWorld) => w.db.get(projectPlaybookKey(ORG_A, "web")) as Record<string, unknown> | undefined;
const setLock = (w: MergeWorld, lock: unknown, revision: number | undefined = 1) => w.db.set({ pk: orgMetaKey(ORG_A).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_LOCK", lock, ...(revision === undefined ? {} : { revision }) });
const designEvents = (w: MergeWorld) => w.audit.recordedBy("playbook.design_review_changed");

describe("an old playbook", () => {
  it("reads the owner's defaults: a document with no designReview, and a project with no document", async () => {
    const w = mergeWorld();
    // A document exactly as the code before this stage wrote it.
    w.db.set({ ...projectPlaybookKey(ORG_A, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision: 3, defaultProcess: { kind: "builtin" }, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAX });
    const read = await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web");
    expect(read).toEqual({ playbook: { revision: 3, defaultProcess: { kind: "builtin" } } });
    expect(designReviewSettingOf(read.playbook)).toEqual(DESIGN_REVIEW_DEFAULT_SETTING);
    expect((await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web")).setting).toEqual(DESIGN_REVIEW_DEFAULT_SETTING);
    const empty = mergeWorld();
    expect((await readEffectiveDesignReview(playbookDeps(empty), ORG_A, "web")).setting).toEqual(DESIGN_REVIEW_DEFAULT_SETTING);
  });

  it("keeps working when the stored setting cannot be read: the process stays available and the setting reads as the strictest, never a looser one", async () => {
    const w = mergeWorld();
    w.db.set({ ...projectPlaybookKey(ORG_A, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision: 2, defaultProcess: { kind: "builtin" }, designReview: { mode: "sometimes" } });
    const read = await readProjectPlaybook(playbookDeps(w), ORG_A, "web");
    expect(read.defaultProcess).toEqual({ kind: "builtin" });
    expect(read.designReview).toEqual(DESIGN_REVIEW_FAIL_CLOSED_SETTING);
    expect(read.designReview).toMatchObject({ mode: "always", allowSkip: false });
  });
});

describe("saving the setting", () => {
  it("lets a maintainer save it, returns it, and records playbook.design_review_changed in the same transaction (fixed words and counts only)", async () => {
    const w = mergeWorld();
    const reply = await put(w, MAX, { designReview: SETTING });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ playbook: { revision: 1, defaultProcess: { kind: "builtin" }, designReview: SETTING } });
    expect(await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web")).toEqual({ playbook: { revision: 1, defaultProcess: { kind: "builtin" }, designReview: SETTING } });
    const events = designEvents(w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: MAX }, target: { kind: "project" }, facts: { revision: 1, mode: "always", tier: "thorough", allowSkip: false, capCents: 2500, approverKind: "people", approverCount: 2 } });
    // The people named as the approver are never in the event.
    expect(JSON.stringify(events[0])).not.toContain("secret-person");
    const written = w.db.transactions().find((items) => items.some((entry) => JSON.stringify(entry).includes("PROJECT_PLAYBOOK")))!;
    expect(JSON.stringify(written)).toContain("AUDIT_PENDING");
    expect(JSON.stringify(written)).toContain("playbook.design_review_changed");
    // The process event is still recorded: a write is still a write of the playbook.
    expect(w.audit.recordedBy("playbook.default_process_changed")).toHaveLength(1);
  });

  it("writes nothing when the audit outbox write fails: the setting and its event commit together", async () => {
    const w = mergeWorld();
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "InternalServerError" }, times: 1 });
    await expect(put(w, MAX, { designReview: SETTING })).rejects.toMatchObject({ name: "InternalServerError" });
    expect(stored(w)).toBeUndefined();
    expect(designEvents(w)).toEqual([]);
  });

  it("records no design event when the setting did not change (saving the defaults over nothing, or the same value again)", async () => {
    const w = mergeWorld();
    await put(w, MAX, { designReview: DESIGN_REVIEW_DEFAULT_SETTING });
    expect(designEvents(w)).toEqual([]);
    await put(w, MAX, { expectedRevision: 1, designReview: SETTING });
    expect(designEvents(w)).toHaveLength(1);
    await put(w, MAX, { expectedRevision: 2, designReview: SETTING });
    expect(designEvents(w)).toHaveLength(1);
    await put(w, MAX, { expectedRevision: 3, designReview: { ...SETTING, tier: "light" } });
    expect(designEvents(w).map((event) => event.facts)).toMatchObject([{ tier: "thorough" }, { tier: "light" }]);
  });

  it("keeps the setting across a write that carries none (a change of process must not drop it)", async () => {
    const w = mergeWorld();
    await put(w, MAX, { designReview: SETTING });
    const reply = await put(w, MAX, { expectedRevision: 1 });
    expect(reply.body).toEqual({ playbook: { revision: 2, defaultProcess: { kind: "builtin" }, designReview: SETTING } });
    expect(stored(w)).toMatchObject({ revision: 2, designReview: SETTING });
    expect(designEvents(w)).toHaveLength(1);
  });

  it("is a maintainer's: a contributor and a viewer are refused and nothing is written", async () => {
    const w = mergeWorld();
    expect(await failure(put(w, PRIYA, { designReview: SETTING }))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await failure(put(w, MIA, { designReview: SETTING }))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(stored(w)).toBeUndefined();
    expect(designEvents(w)).toEqual([]);
  });

  it("takes only the shape the contract has: a cap out of range, an unknown mode or an extra field is refused", async () => {
    const w = mergeWorld();
    for (const bad of [{ ...SETTING, capUsdPerTask: 0.1 }, { ...SETTING, capUsdPerTask: 101 }, { ...SETTING, mode: "sometimes" }, { ...SETTING, extra: 1 }, { ...SETTING, highRiskApprover: { kind: "people", memberIds: [] } }]) {
      expect(await failure(put(w, MAX, { designReview: bad }))).toMatchObject({ code: "CONFIG_INVALID", status: 400 });
    }
    expect(ProjectPlaybookBodySchema.safeParse({ expectedRevision: 0, defaultProcess: { kind: "builtin" }, designReview: SETTING }).success).toBe(true);
    expect(stored(w)).toBeUndefined();
  });

  it("refuses a design review setting riding on a switch back to the built-in that could wait for a second person (the setting would be lost)", async () => {
    const w = mergeWorld();
    const agent = await w.store.create({ orgId: ORG_A, name: "web process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, createdBy: MAX, extends: "rovara-code", purpose: "process" });
    await w.store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: agent.draftRevision, digest: "a".repeat(64), by: MAX });
    await put(w, MAX, { defaultProcess: { kind: "project_process", agentId: agent.agentId } });
    const result = await failure(put(w, MAX, { expectedRevision: 1, designReview: SETTING }));
    expect(result).toMatchObject({ code: "CONFIG_INVALID", status: 400 });
    expect(result?.message).toContain("change the process first");
    expect(stored(w)).toMatchObject({ revision: 1, defaultProcess: { kind: "project_process" } });
  });
});

describe("the company's lock is stricter-only", () => {
  it("refuses every way a project could loosen it, naming only the fields, and writes nothing", async () => {
    const w = mergeWorld();
    const lock: DesignReviewLock = { mode: "always", tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 5, approverGroupId: "security-leads" };
    setLock(w, lock);
    const loose: DesignReviewSetting = { mode: "never", tier: "light", allowSkip: true, capUsdPerTask: 20, highRiskApprover: { kind: "maintainers" } };
    const result = await failure(put(w, MAX, { designReview: loose }));
    expect(result).toMatchObject({ code: "CONFIG_INVALID", status: 400 });
    expect(result?.message).toBe("designReview.mode, designReview.tier, designReview.allowSkip, designReview.capUsdPerTask, designReview.highRiskApprover: your company has set a stricter rule for design review");
    // No value of the lock or of the request is echoed.
    expect(result?.message).not.toMatch(/security-leads|always|20|\b5\b/u);
    expect(stored(w)).toBeUndefined();
    expect(designEvents(w)).toEqual([]);
    // Each field alone is enough to be refused.
    const okAll: DesignReviewSetting = { mode: "always", tier: "standard", allowSkip: false, capUsdPerTask: 5, highRiskApprover: { kind: "group", groupId: "security-leads" } };
    for (const [field, change] of [
      ["designReview.mode", { mode: "auto" }], ["designReview.tier", { tier: "light" }], ["designReview.allowSkip", { allowSkip: true }],
      ["designReview.capUsdPerTask", { capUsdPerTask: 5.01 }], ["designReview.highRiskApprover", { highRiskApprover: { kind: "group", groupId: "other-group" } }],
    ] as const) {
      expect(await failure(put(w, MAX, { designReview: { ...okAll, ...change } }))).toMatchObject({ code: "CONFIG_INVALID", message: `${field}: your company has set a stricter rule for design review` });
    }
    // Exactly the lock, and anything stricter, is accepted.
    expect((await put(w, MAX, { designReview: okAll })).statusCode).toBe(200);
    expect((await put(w, MAX, { expectedRevision: 1, designReview: { ...okAll, tier: "thorough", capUsdPerTask: 1 } })).statusCode).toBe(200);
  });

  it("a mode lock of auto forbids never but allows always; a lock that sets no field locks nothing", async () => {
    const w = mergeWorld();
    setLock(w, { mode: "auto" });
    expect(await failure(put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always" } })).statusCode).toBe(200);
    const open = mergeWorld();
    setLock(open, {});
    expect((await put(open, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never", allowSkip: true } })).statusCode).toBe(200);
  });

  it("clamps what is stored when a lock is added AFTER a project chose something looser: the effective setting holds the lock, the stored one is untouched", async () => {
    const w = mergeWorld();
    await put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never", tier: "light", allowSkip: true, capUsdPerTask: 30 } });
    setLock(w, { mode: "always", tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8, approverGroupId: "leads" });
    const effective = await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web");
    expect(effective.setting).toEqual({ mode: "always", tier: "standard", allowSkip: false, capUsdPerTask: 8, highRiskApprover: { kind: "group", groupId: "leads" } });
    expect(effective.locked).toEqual(["designReview.mode", "designReview.tier", "designReview.allowSkip", "designReview.capUsdPerTask", "designReview.highRiskApprover"]);
    expect(stored(w)).toMatchObject({ designReview: { mode: "never", tier: "light" } });
    // A project already stricter than the lock keeps its own stricter values.
    const strict = mergeWorld();
    await put(strict, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 2 } });
    setLock(strict, { mode: "auto", tierAtLeast: "standard", capCeilingUsd: 8 });
    expect((await readEffectiveDesignReview(playbookDeps(strict), ORG_A, "web")).setting).toMatchObject({ mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 2 });
  });

  it("a lock that is stored but unreadable is never read as no lock: a write is refused and the effective setting is the strictest", async () => {
    const w = mergeWorld();
    setLock(w, { mode: "sometimes", surprise: true });
    const result = await failure(put(w, MAX, { designReview: SETTING }));
    expect(result).toMatchObject({ code: "CONFIG_INVALID", status: 400 });
    expect(result?.message).toContain("can't be read");
    expect(stored(w)).toBeUndefined();
    const effective = await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web");
    expect(effective).toMatchObject({ lockUnreadable: true, setting: { mode: "always", allowSkip: false } });
    // A write with no design review setting is not blocked by the lock.
    expect((await put(w, MAX, {})).statusCode).toBe(200);
  });

  it("the pure rules: violations, applying a lock and the effective setting agree", () => {
    const lock: DesignReviewLock = { mode: "auto", tierAtLeast: "thorough", allowSkip: false, capCeilingUsd: 3 };
    const clamped = applyLock({ ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" }, lock);
    expect(lockViolations(clamped, lock)).toEqual([]);
    expect(clamped).toMatchObject({ mode: "auto", tier: "thorough", allowSkip: false, capUsdPerTask: 3 });
    expect(effectiveDesignReviewSetting({}, { kind: "lock", lock, revision: 1 })).toEqual(applyLock(DESIGN_REVIEW_DEFAULT_SETTING, lock));
    expect(effectiveDesignReviewSetting({}, { kind: "none" })).toEqual(DESIGN_REVIEW_DEFAULT_SETTING);
  });
});

describe("groups are Enterprise only", () => {
  const withGroup: DesignReviewSetting = { ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "group", groupId: "security-leads" } };
  it("refuses a group as the high-risk approver in the Public edition, and when the edition is not known", async () => {
    const w = mergeWorld();
    expect(await failure(put(w, MAX, { designReview: withGroup }, { edition: editionPolicy("public") }))).toMatchObject({ code: "CONFIG_INVALID", message: "designReview: a group can be the high-risk approver only in the Enterprise edition" });
    expect(await failure(put(w, MAX, { designReview: withGroup }, { edition: undefined }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(stored(w)).toBeUndefined();
    // Maintainers and named people are fine in Public.
    expect((await put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "people", memberIds: [PRIYA] } } }, { edition: editionPolicy("public") })).statusCode).toBe(200);
  });
  it("accepts it in Enterprise", async () => {
    const w = mergeWorld();
    expect((await put(w, MAX, { designReview: withGroup })).statusCode).toBe(200);
    expect(designEvents(w)[0]).toMatchObject({ facts: { approverKind: "group", approverCount: 1 } });
    expect(JSON.stringify(designEvents(w))).not.toContain("security-leads");
  });
});


describe("fix round: the setting survives an unreadable process (M2)", () => {
  const item = (w: MergeWorld, extra: Record<string, unknown>) => w.db.set({ ...projectPlaybookKey(ORG_A, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision: 2, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAX, ...extra });
  const STRICT: DesignReviewSetting = { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", allowSkip: false, capUsdPerTask: 3 };

  it("a lenient read keeps a stored setting that parses, though the process does not", async () => {
    const w = mergeWorld();
    item(w, { defaultProcess: { kind: "from_the_future" }, designReview: STRICT });
    const read = await readProjectPlaybook(playbookDeps(w), ORG_A, "web", { lenient: true });
    expect(read).toEqual({ revision: 2, defaultProcess: { kind: "builtin" }, designReview: STRICT });
    expect((await readProjectPlaybookState(playbookDeps(w), ORG_A, "web")).playbook.designReview).toEqual(STRICT);
    expect((await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web")).setting).toEqual(STRICT);
    expect(await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web")).toMatchObject({ playbook: { designReview: STRICT } });
  });

  it("and the strictest posture when the setting does not parse either; no setting stays none", async () => {
    const w = mergeWorld();
    item(w, { defaultProcess: { kind: "from_the_future" }, designReview: { mode: "sometimes" } });
    expect((await readProjectPlaybook(playbookDeps(w), ORG_A, "web", { lenient: true })).designReview).toEqual(DESIGN_REVIEW_FAIL_CLOSED_SETTING);
    const bare = mergeWorld();
    item(bare, { defaultProcess: { kind: "from_the_future" } });
    expect((await readProjectPlaybook(playbookDeps(bare), ORG_A, "web", { lenient: true })).designReview).toBeUndefined();
  });

  it("a later write through the lenient read does not erase the strict setting", async () => {
    const w = mergeWorld();
    item(w, { defaultProcess: { kind: "from_the_future" }, designReview: STRICT });
    await writeProjectPlaybook(playbookDeps(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 2, defaultProcess: { kind: "builtin" } });
    expect(stored(w)).toMatchObject({ revision: 3, designReview: STRICT });
    expect((await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web")).setting).toMatchObject({ mode: "always", allowSkip: false, capUsdPerTask: 3 });
  });
});

describe("fix round: the lock is enforced in the write transaction and on the read (M3)", () => {
  const LOOSE: DesignReviewSetting = { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never", allowSkip: true, capUsdPerTask: 30 };
  /** A client that lets the lock appear (or change) AFTER the writer has read it and before its transaction commits. */
  const racing = (w: MergeWorld, change: () => void): ProjectPlaybookDependencies => {
    let fired = false;
    const real = w.db;
    const client = { send: async (command: { constructor: { name: string }; input?: { Key?: { sk?: string } } }) => {
      const result = await (real as unknown as { send(c: unknown): Promise<unknown> }).send(command);
      if (!fired && command.constructor.name === "GetCommand" && command.input?.Key?.sk === DESIGN_REVIEW_LOCK_SK) { fired = true; change(); }
      return result;
    } };
    return playbookDeps(w, { documentClient: client });
  };
  const write = (deps: ProjectPlaybookDependencies, designReview: DesignReviewSetting) => writeProjectPlaybook(deps, { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 0, defaultProcess: { kind: "builtin" }, designReview });

  it("a lock added between the writer's read and its commit refuses the write; nothing looser is stored", async () => {
    const w = mergeWorld();
    const result = await failure(write(racing(w, () => setLock(w, { mode: "always", allowSkip: false })), LOOSE));
    expect(result).toMatchObject({ code: "PLAYBOOK_STALE" });
    expect(stored(w)).toBeUndefined();
    expect(designEvents(w)).toEqual([]);
  });

  it("a lock that is changed (a new revision) after the read refuses the write too; the same lock lets it through", async () => {
    const w = mergeWorld();
    setLock(w, { capCeilingUsd: 50 }, 1);
    expect(await failure(write(racing(w, () => setLock(w, { capCeilingUsd: 5 }, 2)), { ...LOOSE, capUsdPerTask: 40 }))).toMatchObject({ code: "PLAYBOOK_STALE" });
    expect(stored(w)).toBeUndefined();
    const ok = mergeWorld();
    setLock(ok, { capCeilingUsd: 50 }, 1);
    expect((await write(playbookDeps(ok), { ...LOOSE, capUsdPerTask: 40 })).designReview).toMatchObject({ capUsdPerTask: 40 });
  });

  it("the writer holds the lock on its own, whatever the route checked", async () => {
    const w = mergeWorld();
    setLock(w, { allowSkip: false });
    expect(await failure(write(playbookDeps(w), LOOSE))).toMatchObject({ code: "CONFIG_INVALID", message: "designReview.allowSkip: your company has set a stricter rule for design review" });
    expect(stored(w)).toBeUndefined();
    // A lock item with no whole-number revision cannot be conditioned on, so it is unreadable and refuses (fail closed).
    const noRevision = mergeWorld();
    setLock(noRevision, { allowSkip: false }, undefined);
    expect(await failure(write(playbookDeps(noRevision), LOOSE))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("GET shows the setting held to the lock, with the locked fields named; the stored value is untouched", async () => {
    const w = mergeWorld();
    await put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never", allowSkip: true, capUsdPerTask: 30 } });
    setLock(w, { mode: "always", allowSkip: false, capCeilingUsd: 8 });
    const read = await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web");
    expect(read.playbook.designReview).toMatchObject({ mode: "always", allowSkip: false, capUsdPerTask: 8 });
    expect(read.designReviewLocked).toEqual(["designReview.mode", "designReview.allowSkip", "designReview.capUsdPerTask"]);
    expect(stored(w)).toMatchObject({ designReview: { mode: "never", allowSkip: true, capUsdPerTask: 30 } });
    // No lock: the answer is exactly what it was.
    const open = mergeWorld();
    expect(await getProjectPlaybook(playbookDeps(open), w.caller(PRIYA), "web")).toEqual({ playbook: { revision: 0, defaultProcess: { kind: "builtin" } } });
    // An unreadable lock: the strictest setting, every field shown as locked.
    const broken = mergeWorld();
    setLock(broken, { surprise: true });
    const shown = await getProjectPlaybook(playbookDeps(broken), w.caller(PRIYA), "web");
    expect(shown.playbook.designReview).toMatchObject({ mode: "always", allowSkip: false });
    expect(shown.designReviewLocked).toHaveLength(5);
  });

  it("only a setting held to the lock is the effective one: the brand is set by the lock code alone", async () => {
    const w = mergeWorld();
    expect(isEffectiveSetting((await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web")).setting)).toBe(true);
    expect(isEffectiveSetting({ ...DESIGN_REVIEW_DEFAULT_SETTING })).toBe(false);
    expect(isEffectiveSetting(effectiveDesignReviewSetting({}, { kind: "none" }))).toBe(true);
  });
});

describe("fix round: an unreadable lock clamps the cap, tier and approver too (L1)", () => {
  it("a project's loose cap, light tier and named approver are replaced by the default cap, at least the default tier and the maintainers", () => {
    const own: DesignReviewSetting = { mode: "auto", tier: "light", allowSkip: true, capUsdPerTask: 80, highRiskApprover: { kind: "people", memberIds: ["me"] } };
    expect(effectiveDesignReviewSetting({ designReview: own }, { kind: "unreadable" })).toEqual({ mode: "always", tier: DESIGN_REVIEW_DEFAULT_SETTING.tier, allowSkip: false, capUsdPerTask: DESIGN_REVIEW_DEFAULT_SETTING.capUsdPerTask, highRiskApprover: { kind: "maintainers" } });
    // A project already stricter on cap and tier keeps those.
    expect(effectiveDesignReviewSetting({ designReview: { ...own, tier: "thorough", capUsdPerTask: 2 } }, { kind: "unreadable" })).toMatchObject({ tier: "thorough", capUsdPerTask: 2, highRiskApprover: { kind: "maintainers" } });
  });
});

describe("fix round: a group lock needs Enterprise (L2)", () => {
  it("the lock's writer refuses a group in Public and when the edition is unknown, and says why", () => {
    expect(checkDesignReviewLockWrite({ approverGroupId: "g" }, editionPolicy("public"))).toEqual({ ok: false, reason: "group_not_available", message: DESIGN_REVIEW_LOCK_GROUP_EDITION });
    expect(checkDesignReviewLockWrite({ approverGroupId: "g" }, undefined)).toMatchObject({ ok: false });
    expect(checkDesignReviewLockWrite({ approverGroupId: "g" }, editionPolicy("enterprise"))).toEqual({ ok: true });
    expect(checkDesignReviewLockWrite({ mode: "always" }, editionPolicy("public"))).toEqual({ ok: true });
  });
});

describe("fix round: named people must be able to approve (L4)", () => {
  const candidates = (ids: string[]) => async () => ids;
  it("refuses an id that is not a maintainer or approving member, without echoing it; accepts the candidates", async () => {
    const w = mergeWorld();
    const people = (memberIds: string[]): DesignReviewSetting => ({ ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "people", memberIds } });
    const result = await failure(put(w, MAX, { designReview: people([MAX, "a-viewer-id"]) }, { namedApproverCandidates: candidates([MAX, PRIYA]) }));
    expect(result).toMatchObject({ code: "CONFIG_INVALID", message: "designReview: name only project maintainers or members who can approve" });
    expect(result?.message).not.toContain("a-viewer-id");
    expect(stored(w)).toBeUndefined();
    expect((await put(w, MAX, { designReview: people([MAX, PRIYA]) }, { namedApproverCandidates: candidates([MAX, PRIYA]) })).statusCode).toBe(200);
    // Maintainers and a group are not "named people": the check does not apply.
    expect((await put(w, MAX, { expectedRevision: 1, designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING } }, { namedApproverCandidates: candidates([]) })).statusCode).toBe(200);
  });
});

describe("money fix round 2: L4 fails closed, N7 one view", () => {
  const people = (memberIds: string[]): DesignReviewSetting => ({ ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "people", memberIds } });

  it("L4: naming people with no candidate list is refused (not accepted unchecked); maintainers need no list; ids are compared folded", async () => {
    const w = mergeWorld();
    const unchecked = await failure(put(w, MAX, { designReview: people([MAX]) }, { namedApproverCandidates: undefined }));
    expect(unchecked).toMatchObject({ code: "CONFIG_INVALID", message: "designReview: who can approve can't be checked right now, so people can't be named" });
    expect(stored(w)).toBeUndefined();
    expect((await put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING } }, { namedApproverCandidates: undefined })).statusCode).toBe(200);
    const folded = mergeWorld();
    expect((await put(folded, MAX, { designReview: people([` ${PRIYA.toUpperCase()} `]) }, { namedApproverCandidates: async () => [PRIYA] })).statusCode).toBe(200);
    expect(await failure(put(mergeWorld(), MAX, { designReview: people(["someone-else"]) }, { namedApproverCandidates: async () => [PRIYA] }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("N7: the answer to a PUT is the same clamped view as a GET, with the locked fields named; the stored value is still the project's own", async () => {
    const w = mergeWorld();
    await put(w, MAX, { designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never", allowSkip: true, capUsdPerTask: 30 } });
    setLock(w, { mode: "always", allowSkip: false, capCeilingUsd: 8 });
    const reply = await put(w, MAX, { expectedRevision: 1 });
    const read = await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web");
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual(read);
    expect(read.designReviewLocked).toEqual(["designReview.mode", "designReview.allowSkip", "designReview.capUsdPerTask"]);
    expect(read.playbook.designReview).toMatchObject({ mode: "always", allowSkip: false, capUsdPerTask: 8 });
    expect(stored(w)).toMatchObject({ revision: 2, designReview: { mode: "never", allowSkip: true, capUsdPerTask: 30 } });
  });
});
