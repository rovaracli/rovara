// L4-T2 (setup review D1, G1, G6), Cloud's side: "Setup run: Done" means a person APPROVED the setup and its check on a fresh machine is ready. Code (pr/l4-setup-done-approved) now sends the row's
// `approval` (none, candidate, checking, approved), the check's `status` and failing step, and when it was approved; this Cloud reads them strictly (an answer without `approval` is one it cannot read: land
// with Code's change) and drops everything else it does not know. The AI row is done only while the company can run a model call: Cloud knows that (`agentAiConnected`), so a definite "no" turns the row to
// needs_you, stops the first task, and moves the progress and the next required row with it. Every other row is as Code sent it. Two companies never meet.
import { describe, expect, it } from "vitest";
import { SETUP_CHECKLIST_ROUTES, checklistAnswer, withModelCallFact } from "../../packages/cloud-server/src/index.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { ProjectSetupChecklistSchema } from "../../packages/contracts/src/project-setup-status.js";
import { SETUP_STATUS_NO_EVALS } from "../fixtures/code-answers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64);
type Plain = Record<string, unknown>;
const code = (over: Plain = {}): Plain => ({ ...structuredClone(SETUP_STATUS_NO_EVALS), ...over });
const run = (over: Plain): Plain => ({ ...(code()["setupRun"] as Plain), ...over });
const rebuild = (value: unknown) => checklistAnswer(value, "alpha");

describe("the checklist read keeps Code's approval fields, strictly", () => {
  it("rebuilds approval, the check (status and failing step) and when it was approved; the app's schema reads it", () => {
    const answer = rebuild(code());
    expect(answer["setupRun"]).toMatchObject({ state: "done", status: "ready", approval: "approved", check: { status: "ready" }, approvedAt: "2026-11-17T11:59:00.000Z" });
    expect(ProjectSetupChecklistSchema.safeParse(answer).success).toBe(true);
    const failed = rebuild(code({ setupRun: run({ state: "needs_you", approval: "candidate", check: { status: "failed", failedStep: "test: npm test - exited with 1" }, approvedAt: undefined }) }));
    expect((failed["setupRun"] as Plain)["check"]).toEqual({ status: "failed", failedStep: "test: npm test - exited with 1" });
  });

  it("an answer with no approval is not one this Cloud reads (land with Code's change): the whole read is refused", () => {
    expect(() => rebuild(code({ setupRun: run({ approval: undefined }) }))).toThrow();
  });

  it("refuses an unknown approval word, an unknown check status, a failing step that is too long or holds a control character, and a bad approval time", () => {
    for (const bad of [
      run({ approval: "approved-ish" }), run({ approval: undefined }), run({ check: { status: "weird" } }), run({ check: { status: "failed", failedStep: "x".repeat(301) } }),
      run({ check: { status: "failed", failedStep: "line one\nline two" } }), run({ check: "ready" }), run({ approvedAt: "x".repeat(41) }),
    ]) expect(() => rebuild(code({ setupRun: bad })), JSON.stringify(bad)).toThrow();
  });

  it("drops a field of the check that Code did not promise, and keeps the AI row's model-call word only when it is one", () => {
    const answer = rebuild(code({ setupRun: run({ check: { status: "ready", secret: "LEAK" } }), aiAndSpend: { ...(code()["aiAndSpend"] as Plain), modelCall: "possible", extra: "LEAK" } }));
    expect(JSON.stringify(answer)).not.toContain("LEAK");
    expect((answer["aiAndSpend"] as Plain)["modelCall"]).toBe("possible");
    expect(() => rebuild(code({ aiAndSpend: { ...(code()["aiAndSpend"] as Plain), modelCall: "maybe" } }))).toThrow();
  });

  it("changes nothing else: every other row, and every older field of these two rows, is rebuilt exactly as before", () => {
    const input = code({ aiAndSpend: { ...(code()["aiAndSpend"] as Plain), modelCall: "possible" } });
    const answer = rebuild(input);
    for (const row of ["project", "viewer", "progress", "repos", "evalConfirm", "slackChannel", "linear", "invites", "firstTask"]) expect(answer[row], row).toEqual(input[row]);
    const without = (row: unknown, ...keys: string[]) => Object.fromEntries(Object.entries(row as Plain).filter(([key]) => !keys.includes(key)));
    expect(without(answer["setupRun"], "approval", "check", "approvedAt")).toEqual(without(input["setupRun"], "approval", "check", "approvedAt"));
    expect(without(answer["aiAndSpend"], "modelCall")).toEqual(without(input["aiAndSpend"], "modelCall"));
  });
});

describe("the AI row is done only while a model call is possible (G6)", () => {
  const base = () => rebuild(code());
  it("a definite no: the AI row is needs_you, the first task cannot start, the progress and the next required row follow", () => {
    const before = base();
    const after = withModelCallFact(before, false);
    expect(after["aiAndSpend"]).toMatchObject({ state: "needs_you", modelCall: "none", source: "default" });
    expect(after["firstTask"]).toEqual({ state: "needs_you", hasTask: false, canStart: false });
    expect(after["progress"]).toEqual({ done: 3, total: 8, percent: 38, nextRequired: "aiAndSpend" });
    expect(ProjectSetupChecklistSchema.safeParse(after).success).toBe(true);
    // Nothing else moved, and the input was not changed.
    for (const row of ["project", "viewer", "repos", "setupRun", "evalConfirm", "slackChannel", "linear", "invites"]) expect(after[row], row).toEqual(before[row]);
    expect((before["aiAndSpend"] as Plain)["state"]).toBe("done");
  });

  it("a yes, or not knowing, leaves Code's answer exactly as it is (the same object)", () => {
    const before = base();
    expect(withModelCallFact(before, true)).toBe(before);
    expect(withModelCallFact(before, null)).toBe(before);
  });

  it("a row Code already said needs_you is left alone; skipped rows count toward the progress", () => {
    const already = rebuild(code({ aiAndSpend: { ...(code()["aiAndSpend"] as Plain), state: "needs_you", modelCall: "none" } }));
    expect(withModelCallFact(already, false)).toBe(already);
    const skipped = rebuild(code({ slackChannel: { state: "skipped", channels: [] }, linear: { state: "skipped", team: null }, invites: { state: "skipped" } }));
    expect((withModelCallFact(skipped, false)["progress"] as Plain)["done"]).toBe(6);
  });

  it("the next required row is the first one that is not done, in the checklist's order", () => {
    const early = rebuild(code({ repos: { state: "needs_you", count: 0, items: [] } }));
    expect((withModelCallFact(early, false)["progress"] as Plain)["nextRequired"]).toBe("repos");
    const later = rebuild(code({ firstTask: { state: "done", hasTask: true, canStart: true } }));
    const out = withModelCallFact(later, false);
    expect((out["progress"] as Plain)["nextRequired"]).toBe("aiAndSpend");
    expect((out["firstTask"] as Plain)["hasTask"]).toBe(true);
  });
});

describe("GET the checklist: the company's AI fact comes from Cloud, for the company Code names", () => {
  type Source = { saved?: string; anthropic?: boolean; throws?: boolean };
  /** A route context: Code's live access names `company`; the saved AI choice and key store are per company; every key-store read is recorded. */
  function context(company: string, sources: Record<string, Source>, answer: Plain = code()) {
    const asked: string[] = [];
    const of = (id: string): Source => sources[id] ?? {};
    const ctx = {
      params: ["alpha"], query: new URLSearchParams(), session: {},
      client: { access: async () => ({ developerId: ADA, displayName: "Ada", administrator: false, companyId: company, companyRole: "owner", projects: [] }), json: async () => answer },
      company: { rovaraAiExempt: new Set<string>(), store: { agentAi: async (id: string) => { if (of(id).throws === true) throw new Error("down"); return of(id).saved === undefined ? undefined : { source: of(id).saved }; } } },
      productAi: { issuer: "iss", store: { view: async (_i: string, id: string) => { asked.push(id); return { sources: [{ provider: "anthropic", hasKey: true, available: of(id).anthropic === true }] }; } } },
    } as unknown as RouteContext;
    return { ctx, asked };
  }
  const read = async (ctx: RouteContext) => {
    const route = SETUP_CHECKLIST_ROUTES.find((one) => one.method === "GET" && one.path.test("/projects/alpha/setup-status"))!;
    const got = await route.answer(ctx);
    return { status: got.status, body: got.body as Plain };
  };

  it("non-exempt with no key or saved choice: default leaves Code-done AI and first-task readiness intact", async () => {
    const { ctx } = context(A, { [A]: {} });
    const got = await read(ctx);
    expect(got.status).toBe(200);
    expect(got.body["aiAndSpend"]).toEqual(code()["aiAndSpend"]);
    expect(got.body["firstTask"]).toEqual(code()["firstTask"]);
    expect(got.body["progress"]).toEqual(code()["progress"]);
  });

  it("Rovara's AI chosen, or a key that is connected: the row stays done as Code sent it", async () => {
    for (const source of [{ saved: "rovara" }, { anthropic: true }]) {
      const got = await read(context(A, { [A]: source }).ctx);
      expect(got.body["aiAndSpend"]).toMatchObject({ state: "done" });
      expect(got.body["firstTask"]).toMatchObject({ canStart: true });
    }
  });

  it("a key store or choice that cannot be read is 'cannot tell', which never blocks", async () => {
    const got = await read(context(A, { [A]: { throws: true } }).ctx);
    expect(got.body["aiAndSpend"]).toMatchObject({ state: "done" });
  });

  it("two companies: the fact is read for the company Code's live access names, and another company's key never counts", async () => {
    const mine = context(A, { [A]: { saved: "anthropic_key" }, [B]: { anthropic: true, saved: "anthropic_key" } });
    const got = await read(mine.ctx);
    expect(mine.asked).toEqual([A]);
    expect(got.body["aiAndSpend"]).toMatchObject({ state: "needs_you" });
    const theirs = context(B, { [A]: {}, [B]: { anthropic: true, saved: "anthropic_key" } });
    expect((await read(theirs.ctx)).body["aiAndSpend"]).toMatchObject({ state: "done" });
    expect(theirs.asked).toEqual([B]);
  });

  it("a Cloud with no company layer or key store cannot tell: Code's answer is rebuilt as it is", async () => {
    const { ctx } = context(A, {});
    const bare = { ...ctx, company: undefined, productAi: undefined } as unknown as RouteContext;
    expect((await read(bare)).body["aiAndSpend"]).toMatchObject({ state: "done" });
  });
});

it("explicit disconnected own providers still downgrade AI; a Code-blocked AI row is never promoted", async () => {
  const { agentAiConnected } = await import("../../packages/cloud-server/src/agent-ai-presence.js");
  for (const source of ["anthropic_key", "bedrock_byo"]) {
    const ctx = { company: { store: { agentAi: async () => ({ source }) } }, productAi: { bedrock: {}, issuer: "iss", store: { view: async () => ({ sources: [] }) } } } as unknown as RouteContext;
    expect(withModelCallFact(rebuild(code()), await agentAiConnected(ctx, A))["aiAndSpend"]).toMatchObject({ state: "needs_you", modelCall: "none" });
  }
  const blocked = rebuild(code({ aiAndSpend: { ...(code()["aiAndSpend"] as Plain), state: "needs_you", modelCall: "none" } }));
  expect(withModelCallFact(blocked, true)).toBe(blocked);
});
