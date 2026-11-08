// Lessons in production, lane 5, final round: a person's one-click "Merge into the existing lesson" for a possible duplicate (POST .../lessons/{id}/merge). Authority is the point: an eligible person who can read BOTH lessons,
// a live browser session, a version the person read; and the merge itself is the curator's own fold (`mergeInto`) under all its limits, with AND-merged trust flags.
import { describe, expect, it } from "vitest";
import { AgentXError, type OrgId } from "@agentx/contracts";
import { routeLessons, type LessonRouteDependencies } from "../../../packages/broker/src/lessons/routes.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { AccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { DeveloperCaller } from "../../../packages/broker/src/aws/developer-routes.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, allSharedTasks, allowAllAccess, directory, embedder, facts, Judge, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";
import { addSource, world } from "../../support/team-record-core.js";

void addSource;
const names = { memberName: async (_org: OrgId, id: string) => id, isErased: async () => false };
const callerOf = (developerId: string, over: { [K in keyof DeveloperCaller]?: DeveloperCaller[K] | undefined } = {}): DeveloperCaller => ({ developerId, sessionId: "s", amr: "browser", name: developerId, orgId: WS as OrgId, orgRole: "member", browserSession: true, ...over }) as unknown as DeveloperCaller;
const base = `/v1/app/projects/${PROJECT}/lessons`;
const mergePath = (id: string) => `${base}/${id}/merge`;

const prov = (over: Partial<ReturnType<typeof lessonRecord>["provenance"]> = {}) => ({ ...lessonRecord().provenance, authors: ["carl"], ...over });
const target = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({ id: "les_targ0001", status: "active", tier: 1, tierReasons: [], approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" }], provenance: prov(), ...over });
const duplicate = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id: "les_dup00001", status: "pending", tier: 1, tierReasons: ["possible_duplicate"], approvals: [], possibleDuplicateOf: "les_targ0001", pendingExpiresAt: 9e15,
  provenance: prov({ authors: ["dave"], supportTasks: ["task-dup"], sourceEvents: ["ev-dup"] }), ...over,
});

function setup(over: { eligible?: string[]; access?: AccessCheckPort } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const w = world();
  let n = 0;
  const lessons = {
    store, directory: directory({ eligibleIds: over.eligible ?? ["owner", "ann", "bob"] }), settings: settings({}), access: over.access ?? allowAllAccess, audit, now: clock.now, newId: () => `ap-${++n}`, names, sources: { table: w.table },
    embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), alerts: new Alerts(), verifier: verifier("valid"), facts: facts(), judge: new Judge(),
  };
  const taken = new Map<string, number>();
  const rate = async (who: DeveloperCaller, bucket: string, limit: number) => { const key = `${bucket}|${who.developerId}`; const count = (taken.get(key) ?? 0) + 1; taken.set(key, count); return count <= limit; };
  const deps = { lessons, rate, projectFor: async (_who: unknown, raw: string) => ({ name: decodeURIComponent(raw), role: "maintainer" as const }), taskFor: async () => ({ project: PROJECT }) } as unknown as LessonRouteDependencies;
  const call = (caller: DeveloperCaller, method: string, path: string, body: unknown = {}) => routeLessons(deps, caller, method, new URL("https://rovara.test" + path), () => body);
  return { store, audit, call, taken, lessons };
}
const refused = async (promise: Promise<unknown>): Promise<AgentXError> => { try { await promise; } catch (error) { if (error instanceof AgentXError) return error; throw error; } throw new Error("expected a refusal"); };
const unchanged = async (s: ReturnType<typeof setup>) => {
  expect((await s.store.get(KEY, "les_dup00001"))).toMatchObject({ status: "pending", version: 1 });
  expect((await s.store.get(KEY, "les_targ0001"))).toMatchObject({ version: 1 });
  expect(s.audit.actions()).not.toContain("lesson.merged");
};

describe("a person merges a possible duplicate into the lesson it may duplicate", () => {
  it("folds the duplicate's people, tasks and events into the existing lesson, retires the duplicate, and audits lesson.merged by the person", async () => {
    const s = setup();
    await seed(s.store, target(), duplicate());
    expect(await s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 })).toEqual({ done: true });
    const merged = (await s.store.get(KEY, "les_targ0001"))!;
    expect(merged).toMatchObject({ version: 2, status: "active", body: target().body });
    expect(merged.provenance.authors).toEqual(["carl", "dave"]);
    expect(merged.provenance.supportTasks).toContain("task-dup");
    expect(merged.provenance.sourceEvents).toContain("ev-dup");
    expect(await s.store.get(KEY, "les_dup00001")).toMatchObject({ status: "retired", version: 2 });
    const event = s.audit.events.find((e) => e.action === "lesson.merged")!;
    expect(event).toMatchObject({ lessonId: "les_targ0001", actor: "ann", facts: { judged: "person", duplicate: "les_dup00001" } });
    expect(s.taken.get("LESSON_DECISIONS|ann")).toBe(1);
  });

  it("the trust flags are AND-merged: a flag stays only when both lessons have it", async () => {
    const both = { memberCorrection: true as const, claimsSupported: true as const, fromSharedTask: true as const };
    for (const [targetFlags, dupFlags, kept] of [
      [both, both, true], [both, {}, false], [{}, both, false], [{ memberCorrection: true as const }, { memberCorrection: true as const, fromSharedTask: true as const }, false],
    ] as const) {
      const s = setup();
      await seed(s.store, target({ status: "candidate", approvals: [], provenance: prov(targetFlags) }), duplicate({ provenance: prov({ authors: ["dave"], ...dupFlags }) }));
      expect(await s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 })).toEqual({ done: true });
      const p = (await s.store.get(KEY, "les_targ0001"))!.provenance;
      expect(p.memberCorrection === true && p.claimsSupported === true && p.fromSharedTask === true).toBe(kept);
      if (!kept) expect(p.fromSharedTask === true && p.memberCorrection === true && p.claimsSupported === true).toBe(false);
    }
  });

  it("keeps every cap: a merge that would pass the author, task or event bound is refused and both lessons stay as they were", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `person${String(i).padStart(2, "0")}`);
    const fifty = Array.from({ length: 50 }, (_, i) => `task-${String(i).padStart(2, "0")}`);
    for (const [targetProv, dupProv] of [
      [prov({ authors: twenty }), prov({ authors: ["zed"] })],
      [prov({ supportTasks: fifty }), prov({ authors: ["carl"], supportTasks: ["task-extra"] })],
      [prov({ sourceEvents: fifty }), prov({ authors: ["carl"], sourceEvents: ["ev-extra"] })],
    ] as const) {
      const s = setup();
      await seed(s.store, target({ provenance: targetProv }), duplicate({ provenance: dupProv }));
      const error = await refused(s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }));
      expect(error.code).toBe("CHANGE_STALE");
      await unchanged(s);
    }
  });

  it("never lowers a live lesson's trust or narrows its audience", async () => {
    const lower = setup();
    await seed(lower.store, target(), duplicate({ provenance: prov({ authors: ["dave"], minTrust: "system" }) }));
    expect((await refused(lower.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
    await unchanged(lower);
    const narrower = setup();
    // Ann can read the Slack place (the lesson's audience names her), so the refusal is the merge rule, not a missing read.
    narrower.lessons.directory.identity = async () => ({ principals: ["U9"], groups: [] });
    await seed(narrower.store, target(), duplicate({ provenance: prov({ authors: ["dave"], audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/C1", principals: ["U9"], capturedAt: "2026-10-30T00:00:00.000Z", liveCheck: "none" } } as never }) }));
    expect((await refused(narrower.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
    await unchanged(narrower);
  });

  it("a lesson live on trial takes a duplicate only when it is a supported member correction", async () => {
    const onTrial = { trial: { state: "trial" as const, startedAt: 1 }, approvals: [{ approvalId: "t", by: "system:trial", at: 1, mode: "trial" as const }] };
    const plain = setup();
    await seed(plain.store, target(onTrial), duplicate());
    expect((await refused(plain.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
    await unchanged(plain);
    const supported = setup();
    await seed(supported.store, target({ ...onTrial, provenance: prov({ memberCorrection: true, claimsSupported: true }) }), duplicate({ provenance: prov({ authors: ["dave"], memberCorrection: true, claimsSupported: true }) }));
    expect(await supported.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 })).toEqual({ done: true });
  });

  it("refuses a stale version, a lesson that is not waiting, a lesson with no link, and a target that is gone or closed", async () => {
    const stale = setup();
    await seed(stale.store, target(), duplicate());
    expect((await refused(stale.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 7 }))).code).toBe("CHANGE_STALE");
    await unchanged(stale);
    const decided = setup();
    await seed(decided.store, target(), duplicate({ status: "rejected" }));
    expect((await refused(decided.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
    const unlinked = setup();
    await seed(unlinked.store, target(), duplicate({ possibleDuplicateOf: undefined }));
    expect((await refused(unlinked.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
    for (const closed of ["retired", "rejected", "withdrawn"] as const) {
      const s = setup();
      await seed(s.store, target({ status: closed }), duplicate());
      expect((await refused(s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
      await unchanged(s);
    }
    const gone = setup();
    await seed(gone.store, duplicate());
    expect((await refused(gone.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("CHANGE_STALE");
    expect((await refused(gone.call(callerOf("ann"), "POST", mergePath("les_nope0001"), { expectedVersion: 1 }))).code).toBe("NOT_FOUND");
  });

  it("is for a person who decides lessons and holds a live browser session: a stranger, the Auditor and a token are refused, nothing changes", async () => {
    const s = setup();
    await seed(s.store, target(), duplicate());
    expect((await refused(s.call(callerOf("mallory"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("ann", { orgRole: "auditor" as never }), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("ann", { browserSession: undefined }), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("FORBIDDEN");
    expect(s.taken.get("LESSON_DECISIONS|ann")).toBeUndefined();
    await unchanged(s);
  });

  it("needs the body to be exactly the version read (a strict body), and a person who cannot read BOTH lessons is told the lesson is not there", async () => {
    const s = setup();
    await seed(s.store, target(), duplicate());
    expect((await refused(s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), {}))).code).toBe("CONFIG_INVALID");
    expect((await refused(s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1, into: "les_other" }))).code).toBe("CONFIG_INVALID");
    // The existing lesson sits in a place this person cannot read now; the duplicate is open.
    const restrictedTarget = target({ provenance: prov({ audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/CPRIV", principals: ["U9"], capturedAt: "2026-10-30T00:00:00.000Z", liveCheck: "none" } } as never }) });
    const dark = setup({ access: { mayRead: async (_o, _v, places) => places.map(() => false), taskVisibility: allSharedTasks } });
    await seed(dark.store, restrictedTarget, duplicate());
    expect((await refused(dark.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 }))).code).toBe("NOT_FOUND");
    await unchanged(dark);
  });

  it("a merge that loses the race to another write is not applied over it", async () => {
    const s = setup();
    await seed(s.store, target(), duplicate());
    const real = s.lessons.store.commit.bind(s.lessons.store);
    let first = true;
    s.lessons.store.commit = (async (...args: Parameters<typeof real>) => { if (first) { first = false; await seed(s.store, { ...(await s.store.get(KEY, "les_targ0001"))!, version: 2, title: "Changed meanwhile" }); } return real(...args); });
    expect(await s.call(callerOf("ann"), "POST", mergePath("les_dup00001"), { expectedVersion: 1 })).toEqual({ done: true });
    // The retry read the newer target, so its change survives the merge.
    expect((await s.store.get(KEY, "les_targ0001"))).toMatchObject({ title: "Changed meanwhile", version: 3 });
  });
});
