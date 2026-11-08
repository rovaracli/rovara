// Lessons in production, lane 5, round 6 (re-check of round 4 leftovers): (R5-1) a draft the judge calls "same" as a REJECTED lesson keeps the "matches a rejected lesson" reason even when it is also linked to a live
// lesson (possible duplicate, refinement, too many people); (R5-2) a merge into a PENDING lesson clears the approvals given before its evidence, authors and audience changed; (R5-3) the person's merge is audited
// BEFORE it commits (no audit, no merge) and the retired duplicate has its own `lesson.retired` record.
import { beforeEach, describe, expect, it } from "vitest";
import { AgentXError, type OrgId } from "@agentx/contracts";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { routeLessons, type LessonRouteDependencies } from "../../../packages/broker/src/lessons/routes.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { resetNoEmbedderNotice } from "../../../packages/broker/src/lessons/similarity.js";
import type { DeveloperCaller } from "../../../packages/broker/src/aws/developer-routes.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, allowAllAccess, directory, draft, embedder, facts, Judge, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";
import { world } from "../../support/team-record-core.js";

beforeEach(() => { embedder.fail = false; embedder.calls = 0; resetNoEmbedderNotice(); });

describe("R5-1: a draft that matches a rejected lesson keeps that reason when a live neighbour is acted on too", () => {
  const answer = (...v: string[]) => JSON.stringify({ verdicts: v.map((verdict, i) => ({ n: i + 1, verdict })) });
  const REJECTED = "Pause the nightly sync job while the billing service deploys to production.";
  const DRAFT = "Resume the nightly sync job while the billing service deploys to production.";
  const mk = (id: string, body: string, status: "active" | "rejected", authors?: string[]) => lessonRecord({
    id, title: "Advice", description: "", body, status, citations: [], citationChecks: [], approvals: status === "active" ? [{ approvalId: "a", by: "ann", at: 1, mode: "one" }] : [], tier: 1, tierReasons: [], scope: {},
    ...(authors === undefined ? {} : { provenance: { ...lessonRecord().provenance, authors } }),
  });
  function setup(verdicts: string[]) {
    const model = new ScriptedModel([answer(...verdicts)]);
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps = { store, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(), log: () => undefined, newId: () => `les_${String(++n).padStart(4, "0")}`, access: allowAllAccess } as unknown as CurateDeps;
    return { store, model, deps };
  }
  const text = (body: string, over: Parameters<typeof draft>[0] = {}) => draft({ title: "Advice", description: "", body, citations: [], scope: {}, ...over });

  it("a possible duplicate of a live lesson that also resembles a rejected one says so (probe P7)", async () => {
    const s = setup(["same", "same"]);
    await seed(s.store, mk("les_live0001", "Hold the nightly sync job while the billing service rolls out to production.", "active"), mk("les_rej00001", REJECTED, "rejected"));
    const out = await curateDraft(s.deps, KEY, text(DRAFT));
    expect(s.model.calls).toHaveLength(1);
    expect(out).toMatchObject({ outcome: "possible_duplicate", duplicateOf: "les_live0001", lesson: { status: "pending", possibleDuplicateOf: "les_live0001" } });
    expect(out.outcome === "possible_duplicate" && out.lesson.tierReasons).toEqual(["possible_duplicate", "matches_rejected"]);
  });

  it("a refinement of a live lesson that also resembles a rejected one says so", async () => {
    const s = setup(["refines", "same"]);
    await seed(s.store, mk("les_live0001", "Hold the nightly sync job while the billing service rolls out to production.", "active"), mk("les_rej00001", REJECTED, "rejected"));
    const out = await curateDraft(s.deps, KEY, text(DRAFT));
    expect(out).toMatchObject({ outcome: "updated", supersedes: "les_live0001" });
    expect(out.outcome === "updated" && out.lesson.tierReasons).toContain("matches_rejected");
  });

  it("a draft kept apart because a merge would name too many people also says it resembles a rejected lesson", async () => {
    const s = setup(["same", "same"]);
    const authors = Array.from({ length: 20 }, (_, i) => `person-${String(i)}`);
    await seed(s.store, mk("les_live0001", "resume nightly sync job while the billing services deploy to production", "active", authors), mk("les_rej00001", REJECTED, "rejected"));
    const out = await curateDraft(s.deps, KEY, text(DRAFT, { provenance: { ...draft().provenance, authors: ["newcomer"] } }));
    expect(out.outcome).toBe("added");
    expect(out.outcome === "added" && out.lesson.tierReasons).toEqual(["merge_too_many_people", "matches_rejected"]);
  });

  it("control: with no rejected lesson in play the duplicate card carries only its own reason", async () => {
    const s = setup(["same"]);
    await seed(s.store, mk("les_live0001", "Hold the nightly sync job while the billing service rolls out to production.", "active"));
    const out = await curateDraft(s.deps, KEY, text(DRAFT));
    expect(out.outcome === "possible_duplicate" && out.lesson.tierReasons).toEqual(["possible_duplicate"]);
  });
});

describe("R5-2 and R5-3: the person's merge", () => {
  const names = { memberName: async (_org: OrgId, id: string) => id, isErased: async () => false };
  const callerOf = (developerId: string): DeveloperCaller => ({ developerId, sessionId: "s", amr: "browser", name: developerId, orgId: WS as OrgId, orgRole: "member", browserSession: true }) as unknown as DeveloperCaller;
  const mergePath = (id: string) => `/v1/app/projects/${PROJECT}/lessons/${id}/merge`;
  const prov = (over: Partial<ReturnType<typeof lessonRecord>["provenance"]> = {}) => ({ ...lessonRecord().provenance, authors: ["carl"], ...over });
  const target = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({ id: "les_targ0001", status: "active", tier: 1, tierReasons: [], approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" }], provenance: prov(), ...over });
  const duplicate = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
    id: "les_dup00001", status: "pending", tier: 1, tierReasons: ["possible_duplicate"], approvals: [], possibleDuplicateOf: "les_targ0001", pendingExpiresAt: 9e15,
    provenance: prov({ authors: ["dave"], supportTasks: ["task-dup"], sourceEvents: ["ev-dup"] }), ...over,
  });
  function setup() {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const clock = new Clock();
    const w = world();
    let n = 0;
    const lessons = {
      store, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), settings: settings({}), access: allowAllAccess, audit, now: clock.now, newId: () => `ap-${++n}`, names, sources: { table: w.table },
      embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), alerts: new Alerts(), verifier: verifier("valid"), facts: facts(), judge: new Judge(),
    };
    const deps = { lessons, rate: async () => true, projectFor: async (_who: unknown, raw: string) => ({ name: decodeURIComponent(raw), role: "maintainer" as const }), taskFor: async () => ({ project: PROJECT }) } as unknown as LessonRouteDependencies;
    const call = (caller: DeveloperCaller, body: unknown = {}) => routeLessons(deps, caller, "POST", new URL("https://rovara.test" + mergePath("les_dup00001")), () => body);
    return { store, audit, call, lessons };
  }

  it("R5-2 (probe P2): a merge into a PENDING lesson drops the approvals given before its evidence and authors changed; an ACTIVE target keeps its own", async () => {
    const pending = setup();
    await seed(pending.store, target({ status: "pending", pendingExpiresAt: 9e15 }), duplicate());
    expect(await pending.call(callerOf("bob"), { expectedVersion: 1 })).toEqual({ done: true });
    const merged = (await pending.store.get(KEY, "les_targ0001"))!;
    expect(merged).toMatchObject({ status: "pending", version: 2, approvals: [] });
    expect(merged.provenance.authors).toEqual(["carl", "dave"]);

    const active = setup();
    await seed(active.store, target(), duplicate());
    expect(await active.call(callerOf("bob"), { expectedVersion: 1 })).toEqual({ done: true });
    expect((await active.store.get(KEY, "les_targ0001"))!.approvals).toHaveLength(1);
  });

  it("R5-3 (probe P3): with the audit down nothing is merged and the person is told it was not recorded", async () => {
    const s = setup();
    s.lessons.audit.emit = async () => { throw new Error("down"); };
    await seed(s.store, target(), duplicate());
    let refusal: unknown;
    try { await s.call(callerOf("ann"), { expectedVersion: 1 }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(AgentXError);
    expect((refusal as AgentXError).code).toBe("RUNTIME_UNAVAILABLE");
    expect(await s.store.get(KEY, "les_dup00001")).toMatchObject({ status: "pending", version: 1 });
    expect(await s.store.get(KEY, "les_targ0001")).toMatchObject({ version: 1 });
  });

  it("R5-3: the merge is on the record BEFORE the commit, and the retired duplicate has a lesson.retired record under its own id", async () => {
    const s = setup();
    await seed(s.store, target(), duplicate());
    const seen: Array<{ action: string; dupStatus: string | undefined }> = [];
    const original = s.lessons.audit.emit.bind(s.lessons.audit);
    s.lessons.audit.emit = async (event, options) => { seen.push({ action: event.action, dupStatus: (await s.store.get(KEY, "les_dup00001"))?.status }); return original(event, options); };
    expect(await s.call(callerOf("ann"), { expectedVersion: 1 })).toEqual({ done: true });
    expect(seen.map((e) => e.action)).toEqual(expect.arrayContaining(["lesson.merged", "lesson.retired"]));
    expect(seen.every((e) => e.dupStatus === "pending"), "every record is written before the commit").toBe(true);
    const retired = s.audit.events.find((e) => e.action === "lesson.retired")!;
    expect(retired).toMatchObject({ lessonId: "les_dup00001", actor: "ann", facts: { cause: "merged", into: "les_targ0001" } });
    expect(s.audit.events.find((e) => e.action === "lesson.merged")).toMatchObject({ lessonId: "les_targ0001", actor: "ann", facts: { judged: "person", duplicate: "les_dup00001" } });
  });
});
