// Design review stage, DR-FU4 L4 (owner decision 2026-11-05: "in worst case scenarios default should be off"): a project's stored design review setting that is there but cannot be read reads as OFF at every reader,
// never as Always or Auto, with a flag and ONE fixed log line. And the writes that make such a value are refused. Before this, an unreadable stored setting read as Always (DESIGN_REVIEW_FAIL_CLOSED_SETTING) once the company allowed design review.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESIGN_REVIEW_DEFAULT_SETTING, ProjectPlaybookResponseSchema, agentXError, editionPolicy, orgMetaKey, projectPlaybookKey, type DesignReviewSetting, type OrgRole } from "../../packages/contracts/src/index.js";
import { getProjectPlaybook, putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { readProjectPlaybook, readProjectPlaybookDetail, readProjectPlaybookState, writeProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { DESIGN_REVIEW_LOCK_SK } from "../../packages/broker/src/design-review/lock.js";
import { readEffectiveDesignReview, readEffectiveWhenAllowed } from "../../packages/broker/src/design-review/setting.js";
import { designReviewAvailableFor, designReviewEnabledFor, designReviewStillOn } from "../../packages/broker/src/design-review/switch.js";
import { resolveDesignMode } from "../../packages/broker/src/design-review/mode.js";
import { MAX, MIA, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { seedDesignReviewCompany } from "../support/design-review-company.js";

beforeEach(() => { process.env.DESIGN_REVIEW_ENABLED = "1"; });
afterEach(() => { delete process.env.DESIGN_REVIEW_ENABLED; vi.restoreAllMocks(); });

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
const world = (): MergeWorld => { const w = mergeWorld(); seedDesignReviewCompany(w.db, ORG_A, {}); return w; };
function playbookDeps(w: MergeWorld, extra: Partial<ProjectPlaybookDependencies> = {}): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps, edition: editionPolicy("enterprise"),
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
    namedApproverCandidates: async () => [MAX, PRIYA, MIA, OLA],
    ...extra,
  };
}
const OFF: DesignReviewSetting = { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" };
const OK = { mode: "always", tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } as const;
const SECRET = "secret-word-7f3a";
const KEY = projectPlaybookKey(ORG_A, "web");
const putRaw = (w: MergeWorld, designReview: unknown, revision = 2) => w.db.set({ ...KEY, entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision, defaultProcess: { kind: "builtin" }, ...(designReview === undefined ? {} : { designReview }), updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAX });
const stored = (w: MergeWorld) => w.db.get(KEY) as Record<string, unknown> | undefined;
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));

/** The unreadable-setting log lines written while `run` runs (parsed). */
async function logsOf(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const lines: Array<Record<string, unknown>> = [];
  try {
    await run();
    for (const [first] of spy.mock.calls) { try { const parsed = JSON.parse(String(first)) as Record<string, unknown>; if (parsed["event"] === "design_review.project_setting_unreadable") lines.push(parsed); } catch { /* not a log line */ } }
  } finally { spy.mockRestore(); }
  return lines;
}

const CORRUPT: ReadonlyArray<readonly [string, unknown, "wrong_type" | "unknown_mode" | "invalid_shape"]> = [
  ["the mode is a number", { ...OK, mode: 5 }, "wrong_type"],
  ["the mode is a boolean", { ...OK, mode: true }, "wrong_type"],
  ["the mode is a word we don't know", { ...OK, mode: SECRET }, "unknown_mode"],
  ["the mode is in the wrong case", { ...OK, mode: "Always" }, "unknown_mode"],
  ["the setting is a string", SECRET, "wrong_type"],
  ["the setting is a number", 7, "wrong_type"],
  ["the setting is a list", [OK], "wrong_type"],
  ["the setting is null", null, "wrong_type"],
  ["required fields are missing", { mode: "always" }, "invalid_shape"],
  ["the mode is missing", { tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } }, "invalid_shape"],
  ["a field has the wrong type", { ...OK, allowSkip: "yes" }, "invalid_shape"],
  ["a field is out of range", { ...OK, capUsdPerTask: 5000 }, "invalid_shape"],
  ["the tier is a word we don't know", { ...OK, tier: SECRET }, "invalid_shape"],
  ["there is an extra field", { ...OK, [SECRET]: true }, "invalid_shape"],
  ["the approver has an extra field", { ...OK, highRiskApprover: { kind: "maintainers", also: SECRET } }, "invalid_shape"],
];

describe("a stored project setting that cannot be read reads as Off at every reader (never Always or Auto)", () => {
  it.each(CORRUPT)("%s", async (_name, corrupt, reason) => {
    const w = world();
    putRaw(w, corrupt);
    const deps = playbookDeps(w);

    // The store: no setting, flagged, and exactly one fixed log line (org, project, a fixed reason; never a value).
    const detailLogs = await logsOf(async () => {
      const detail = await readProjectPlaybookDetail(deps, ORG_A, "web", { lenient: true });
      expect(detail.designReviewUnreadable).toBe(true);
      expect(detail.playbook).toEqual({ revision: 2, defaultProcess: { kind: "builtin" } });
    });
    expect(detailLogs).toEqual([{ component: "broker", event: "design_review.project_setting_unreadable", orgId: ORG_A, project: "web", reason }]);
    expect(JSON.stringify(detailLogs)).not.toContain(SECRET);
    // The plain read keeps the process available and has no setting (Off).
    expect((await readProjectPlaybook(deps, ORG_A, "web")).designReview).toBeUndefined();
    expect((await readProjectPlaybookState(deps, ORG_A, "web")).playbook.designReview).toBeUndefined();

    // The effective setting, with and without the "company allows it" gate.
    let effective!: Awaited<ReturnType<typeof readEffectiveDesignReview>>;
    expect(await logsOf(async () => { effective = await readEffectiveDesignReview(deps, ORG_A, "web"); })).toHaveLength(1);
    expect(effective).toMatchObject({ setting: OFF, settingUnreadable: true, allowed: true });
    let whenAllowed: Awaited<ReturnType<typeof readEffectiveWhenAllowed>>;
    expect(await logsOf(async () => { whenAllowed = await readEffectiveWhenAllowed(deps, ORG_A, "web"); })).toHaveLength(1);
    expect(whenAllowed!).toMatchObject({ setting: OFF, settingUnreadable: true });

    // The switch: not on for this project; a review the person asked for is still honoured while the stage exists.
    expect(await designReviewEnabledFor(deps, ORG_A, "web")).toBe(false);
    expect(await designReviewStillOn(deps, ORG_A, "web", "auto")).toBe(false);
    expect(await designReviewStillOn(deps, ORG_A, "web", "person")).toBe(true);

    // Mode resolution on that setting: a task gets no design review, even one Understand says needs it, unless the person asked for design first.
    const needs: Parameters<typeof resolveDesignMode>[0]["assessment"] = { kind: "ready", path: "FULL", restatement: "x", assumptions: [], design: { needed: true, reasons: ["new_api"], note: "n" } };
    expect(resolveDesignMode({ setting: effective.setting, assessment: needs })).toMatchObject({ decided: true, on: false, decidedBy: "never" });
    expect(resolveDesignMode({ setting: effective.setting, assessment: needs, designFirst: true })).toMatchObject({ decided: true, on: true, decidedBy: "person" });

    // The page's answer: Off, with the flag (a contract field), and it parses as the contract says.
    const shown = await getProjectPlaybook(deps, w.caller(PRIYA), "web");
    expect(shown).toEqual({ designReviewAllowed: true, designReviewGroups: true, designReviewUnreadable: true, playbook: { revision: 2, defaultProcess: { kind: "builtin" }, designReview: OFF } });
    expect(ProjectPlaybookResponseSchema.parse(shown)).toEqual(shown);
  });

  it("a missing setting is plain Off: no flag, no log line; a well-formed Always or Auto is read as stored", async () => {
    const w = world();
    putRaw(w, undefined);
    const deps = playbookDeps(w);
    const none = await logsOf(async () => {
      expect(await readEffectiveDesignReview(deps, ORG_A, "web")).toMatchObject({ setting: OFF, settingUnreadable: false });
      expect(await getProjectPlaybook(deps, w.caller(PRIYA), "web")).toEqual({ designReviewAllowed: true, designReviewGroups: true, playbook: { revision: 2, defaultProcess: { kind: "builtin" }, designReview: OFF } });
    });
    expect(none).toEqual([]);
    for (const mode of ["never", "always", "auto"] as const) {
      putRaw(w, { ...OK, mode });
      const lines = await logsOf(async () => {
        expect(await readEffectiveDesignReview(deps, ORG_A, "web")).toMatchObject({ setting: { ...OK, mode }, settingUnreadable: false });
        expect((await getProjectPlaybook(deps, w.caller(PRIYA), "web")).designReviewUnreadable).toBeUndefined();
      });
      expect(lines, mode).toEqual([]);
    }
    expect(await designReviewEnabledFor(deps, ORG_A, "web")).toBe(true);
  });

  it("the flag does not leak where the setting is not shown: an unreadable setting with design review off or not allowed adds nothing to the answer", async () => {
    const w = world();
    putRaw(w, { ...OK, mode: SECRET });
    delete process.env.DESIGN_REVIEW_ENABLED;
    expect(await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web")).toEqual({ playbook: { revision: 2, defaultProcess: { kind: "builtin" } } });
    process.env.DESIGN_REVIEW_ENABLED = "1";
    seedDesignReviewCompany(w.db, ORG_A, { allowed: false });
    expect(await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web")).toEqual({ designReviewAllowed: false, playbook: { revision: 2, defaultProcess: { kind: "builtin" } } });
  });
});

describe("the company's lock and policy: an unreadable one means design review is not allowed", () => {
  const company = (w: MergeWorld, item: Record<string, unknown>) => w.db.set({ pk: orgMetaKey(ORG_A).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", orgId: ORG_A, ...item });
  const GOOD = { ...OK, mode: "always" };
  it.each([
    ["a lock with a field we don't know", { revision: 1, lock: { surprise: true }, policy: { allowed: true } }],
    ["a lock that is not a map", { revision: 1, lock: SECRET, policy: { allowed: true } }],
    ["a lock with no readable revision", { revision: "1", lock: {}, policy: { allowed: true } }],
    ["a policy that is not a map", { revision: 1, lock: {}, policy: SECRET }],
    ["a policy whose allowed is not a boolean", { revision: 1, lock: {}, policy: { allowed: "yes" } }],
    ["a policy with an extra word in allowed", { revision: 1, lock: {}, policy: { allowed: 1 } }],
  ])("%s: the stage is not available, nothing about the project is read, and the answer says so, whatever the project chose", async (_name, item) => {
    const w = mergeWorld();
    company(w, item);
    putRaw(w, GOOD);
    const deps = playbookDeps(w);
    expect(await designReviewAvailableFor(deps, ORG_A)).toBe(false);
    expect(await designReviewEnabledFor(deps, ORG_A, "web")).toBe(false);
    expect(await designReviewStillOn(deps, ORG_A, "web", "person")).toBe(false);
    expect(await readEffectiveWhenAllowed(deps, ORG_A, "web")).toBeUndefined();
    expect((await readEffectiveDesignReview(deps, ORG_A, "web")).allowed).toBe(false);
    expect(await getProjectPlaybook(deps, w.caller(PRIYA), "web")).toEqual({ designReviewAllowed: false, playbook: { revision: 2, defaultProcess: { kind: "builtin" } } });
  });

  it("no company item at all is not allowed either", async () => {
    const w = mergeWorld();
    putRaw(w, GOOD);
    expect(await designReviewAvailableFor(playbookDeps(w), ORG_A)).toBe(false);
    expect(await readEffectiveWhenAllowed(playbookDeps(w), ORG_A, "web")).toBeUndefined();
  });
});

describe("writes: a setting is validated before it is stored, and a write rests on what it read", () => {
  const SETTING: DesignReviewSetting = { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", capUsdPerTask: 25 };
  const write = (deps: ProjectPlaybookDependencies, designReview: unknown, expectedRevision = 2) =>
    writeProjectPlaybook(deps, { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision, defaultProcess: { kind: "builtin" }, ...(designReview === undefined ? {} : { designReview: designReview as DesignReviewSetting }) });

  it.each(CORRUPT.filter(([, value]) => value !== null))("refuses to store a setting where %s, naming the field and never the value", async (_name, bad) => {
    const w = world();
    putRaw(w, SETTING);
    const before = structuredClone(stored(w));
    const refused = await failure(write(playbookDeps(w), bad));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(refused!.message).toMatch(/^CONFIG_INVALID: designReview/u);
    expect(refused!.message).not.toContain(SECRET);
    expect(stored(w)).toEqual(before);
    expect(w.db.transactions().filter((items) => JSON.stringify(items).includes("PROJECT_PLAYBOOK"))).toEqual([]);
  });

  it("refuses a null setting from the writer too, and the PUT route refuses every shape the schema does", async () => {
    const w = world();
    putRaw(w, SETTING);
    expect(await failure(write(playbookDeps(w), null))).toMatchObject({ code: "CONFIG_INVALID" });
    for (const [, bad] of CORRUPT) {
      const refused = await failure(putProjectPlaybook(playbookDeps(w), w.caller(MAX), "web", { expectedRevision: 2, defaultProcess: { kind: "builtin" }, designReview: bad }).then((reply) => { if (reply.statusCode >= 400) throw agentXError("CONFIG_INVALID", "refused"); return reply; }));
      expect(refused?.code ?? "accepted").toBe("CONFIG_INVALID");
    }
    expect(stored(w)).toMatchObject({ revision: 2, designReview: SETTING });
  });

  it("a good setting is stored exactly as validated, and a well-formed Always or Auto still works end to end", async () => {
    const w = world();
    putRaw(w, undefined);
    for (const mode of ["always", "auto"] as const) {
      const revision = (stored(w) as { revision: number }).revision;
      await write(playbookDeps(w), { ...SETTING, mode }, revision);
      expect(stored(w)).toMatchObject({ revision: revision + 1, designReview: { ...SETTING, mode } });
      expect(await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web")).toMatchObject({ setting: { mode }, settingUnreadable: false });
    }
  });

  it("a write on a stale revision is refused and changes nothing", async () => {
    const w = world();
    putRaw(w, SETTING);
    const before = structuredClone(stored(w));
    expect(await failure(write(playbookDeps(w), { ...SETTING, mode: "never" }, 1))).toMatchObject({ code: "PLAYBOOK_STALE" });
    expect(stored(w)).toEqual(before);
  });

  /** The documentClient of a writer that, once, runs `race` after the writer has read the item and before it commits (a raw write that does not bump the revision). */
  const racing = (w: MergeWorld, race: () => void): ProjectPlaybookDependencies => {
    let pending: (() => void) | undefined = race;
    return playbookDeps(w, { documentClient: { send: async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && pending !== undefined) { const run = pending; pending = undefined; run(); }
      return w.db.send(command as never);
    } } });
  };

  it("a raw write that ADDED a setting to an item that had none, between the read and the commit and without bumping the revision, refuses the write", async () => {
    const w = world();
    putRaw(w, undefined);
    // Positive control: with no race the same write goes through.
    await write(playbookDeps(w), SETTING);
    expect(stored(w)).toMatchObject({ revision: 3, designReview: SETTING });
    const raced = world();
    putRaw(raced, undefined);
    expect(await failure(write(racing(raced, () => putRaw(raced, { ...SETTING, mode: "never" })), SETTING))).toMatchObject({ code: "PLAYBOOK_STALE" });
    expect(stored(raced)).toMatchObject({ revision: 2, designReview: { mode: "never" } });
  });

  it("a raw write that REMOVED the setting, or bumped the revision, in the same window refuses the write too", async () => {
    const removed = world();
    putRaw(removed, SETTING);
    expect(await failure(write(racing(removed, () => putRaw(removed, undefined)), { ...SETTING, capUsdPerTask: 30 }))).toMatchObject({ code: "PLAYBOOK_STALE" });
    expect(stored(removed)).not.toHaveProperty("designReview");
    const bumped = world();
    putRaw(bumped, SETTING);
    expect(await failure(write(racing(bumped, () => putRaw(bumped, { ...SETTING, mode: "never" }, 3)), { ...SETTING, capUsdPerTask: 30 }))).toMatchObject({ code: "PLAYBOOK_STALE" });
    expect(stored(bumped)).toMatchObject({ revision: 3, designReview: { mode: "never" } });
  });

  it("a stored value that reads fine but does not round-trip (the DocumentClient gave back a different number than is stored) can still be saved over: the value is not pinned", async () => {
    const w = world();
    putRaw(w, { ...SETTING, capUsdPerTask: 25.5 });
    // The read returns the setting with a cap of 25 (a lossy read, as a number with more precision than a double would be); what is stored differs from what the writer saw.
    const lossy = playbookDeps(w, { documentClient: { send: async (command: unknown) => {
      const reply = await w.db.send(command as never) as { Item?: Record<string, unknown> };
      if ((command as { constructor: { name: string } }).constructor.name === "GetCommand" && reply.Item?.["pk"] === KEY.pk && reply.Item["designReview"] !== undefined) return { Item: { ...reply.Item, designReview: { ...SETTING } } };
      return reply;
    } } });
    expect((await readProjectPlaybook(lossy, ORG_A, "web")).designReview).toEqual(SETTING);
    await write(lossy, { ...SETTING, capUsdPerTask: 30 });
    expect(stored(w)).toMatchObject({ revision: 3, designReview: { capUsdPerTask: 30 } });
  });

  it("a process-only save over an unreadable setting records the change, as Off (not as the owner's default Auto); over a readable one it records none", async () => {
    const w = world();
    putRaw(w, { ...OK, mode: SECRET });
    await write(playbookDeps(w), undefined);
    const events = w.audit.recordedBy("playbook.design_review_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: MAX }, facts: { revision: 3, mode: "never", tier: "standard", allowSkip: true, capCents: 1000, approverKind: "maintainers", approverCount: 0 } });
    expect(JSON.stringify(events[0])).not.toContain(SECRET);
    // Positive controls: a readable setting carried over unchanged, and no setting at all, record no design review event.
    const same = world();
    putRaw(same, SETTING);
    await write(playbookDeps(same), undefined);
    const none = world();
    putRaw(none, undefined);
    await write(playbookDeps(none), undefined);
    expect(same.audit.recordedBy("playbook.design_review_changed")).toEqual([]);
    expect(none.audit.recordedBy("playbook.design_review_changed")).toEqual([]);
  });

  it("a corrupt stored setting is NOT locked in: a maintainer choosing again replaces it, and so does saving the process alone (which leaves it Off)", async () => {
    for (const [name, corrupt] of CORRUPT) {
      const w = world();
      putRaw(w, corrupt);
      // Choosing again.
      await write(playbookDeps(w), SETTING);
      expect(stored(w), name).toMatchObject({ revision: 3, designReview: SETTING });
      expect(await readEffectiveDesignReview(playbookDeps(w), ORG_A, "web")).toMatchObject({ setting: { mode: "always" }, settingUnreadable: false });
      // A process-only save over the corrupt value: nothing unreadable is written back, and it reads as plain Off.
      const other = world();
      putRaw(other, corrupt);
      await write(playbookDeps(other), undefined);
      expect(stored(other), name).not.toHaveProperty("designReview");
      expect(await readEffectiveDesignReview(playbookDeps(other), ORG_A, "web")).toMatchObject({ setting: OFF, settingUnreadable: false });
    }
  });

  it("a process-only save keeps a setting that reads (the carry-over still works)", async () => {
    const w = world();
    putRaw(w, SETTING);
    await write(playbookDeps(w), undefined);
    expect(stored(w)).toMatchObject({ revision: 3, designReview: SETTING });
  });
});
