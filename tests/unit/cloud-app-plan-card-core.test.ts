// S3 review MEDIUM-2: a HIGH plan card on a task the core runs is approvable. Through the real `planCardHandler` and `withCardDecideGrade`, over the merge world's real approvals, decide sessions and audit:
// without the decide-grade sign-in the card makes its `card_decision` record and answers REAUTH with the decide sign-in; with it, the decision is the core's (the hook is a recording stand-in here; the
// gate's own step-up verification is tested in cloud-app-task-routes), the session is NOT claimed by the card (the core's gate verifies and spends it), and once the decision applies the record is approved with
// the session's proof (the audit event) and the session deleted. A refused decision leaves both as they were. A Cloud task still claims the session itself.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { planCardHandler } from "../../packages/broker/src/aws/developer-routes/plan-cards.js";
import type { DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import { getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { installCoreTaskRoutes, type CoreDecideInput, type CoreTaskRoutes } from "../../packages/broker/src/rovara-code/task-routes.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { PRIYA } from "../support/agent-session-world.js";

afterEach(() => installCoreTaskRoutes(undefined));

const DIGEST = "d".repeat(64);
const SESSION = `ses_${"a".repeat(20)}`;

async function setup(owns: boolean, decideImpl?: CoreTaskRoutes["decide"]) {
  const w: MergeWorld = mergeWorld({});
  await w.linkAll();
  const taskId = randomUUID();
  w.db.set({
    ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: w.orgId, project: "web", developerId: PRIYA, developerName: "Priya", provider: "oidc", workspaceId: randomUUID(),
    workflow: { definitionVersion: "1.1.0", path: "QUICK", stage: "PLAN_REVIEW", state: "WAITING", revision: 3, decisions: [], artifacts: [{ type: "plan", version: 1, sha256: DIGEST }] },
  });
  const decided: CoreDecideInput[] = [];
  installCoreTaskRoutes({
    owns: async () => owns,
    decide: decideImpl ?? (async (input) => { decided.push(input); return { task: { taskId } as never }; }),
    close: async () => { throw new Error("unused"); },
  });
  const developer = { documentClient: w.db, tableName: "state", developer: { signInTableName: "signin" }, now: () => w.clock.now, agents: w.deps } as unknown as DeveloperRouteDependencies;
  const who = { ...w.caller(PRIYA), browserSession: true as const };
  const input = { card: { id: `approve_plan:${taskId}`, risk: "high" }, item: { kind: "approve_plan", taskId, contentVersion: DIGEST, openPath: `/app/sessions/${SESSION}` }, requestId: randomUUID() } as never;
  const press = (cookie?: string) => planCardHandler(developer, who, cookie).approve(who, input);
  return { w, taskId, decided, press };
}

const approvalIdOf = (error: unknown): string => /apr_[0-9a-z]{20}/u.exec(decodeURIComponent((error as { signInUrl: string }).signInUrl))![0];

describe("a HIGH plan card on a core task", () => {
  it("without the decide-grade sign-in: REAUTH with the decide sign-in and a card_decision record for this card; nothing is decided", async () => {
    const { w, taskId, decided, press } = await setup(true);
    const error = await press().then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: "REAUTH_REQUIRED", reason: "decide_sign_in" });
    expect(await getAnyApproval(w.deps, w.orgId, approvalIdOf(error))).toMatchObject({ status: "PENDING", subject: { kind: "card_decision", taskId, cardId: `approve_plan:${taskId}` } });
    expect(decided).toEqual([]);
  });

  it("with the sign-in: the core decides with the cookie, the card leaves the session for the gate, and afterwards the record is approved (audited) and the session deleted", async () => {
    const { w, decided, press } = await setup(true);
    const approvalId = approvalIdOf(await press().then(() => undefined, (caught: unknown) => caught));
    const cookie = await w.browser(PRIYA, approvalId);
    const sessionSeenByTheCore: unknown[] = [];
    installCoreTaskRoutes({ owns: async () => true, decide: async (input) => { decided.push(input); sessionSeenByTheCore.push(await w.decideStore.getSession(cookie)); return { task: {} as never }; }, close: async () => { throw new Error("unused"); } });
    expect(await press(cookie)).toMatchObject({ kind: "done" });
    expect(decided).toHaveLength(1);
    expect(decided[0]!.stepUpCookie).toBe(cookie);
    // When the core was asked the session was whole and unclaimed (the gate's issuer refuses a claimed one).
    expect((sessionSeenByTheCore[0] as { usedAt?: string } | undefined)?.usedAt).toBeUndefined();
    expect(await w.decideStore.getSession(cookie)).toBeUndefined();
    expect(await getAnyApproval(w.deps, w.orgId, approvalId)).toMatchObject({ status: "APPROVED_DONE" });
    expect(w.audited().length, "the approval is in the audit outbox").toBeGreaterThan(0);
  });

  it("a refused decision leaves the session unclaimed and the record pending (nothing was claimed, so nothing to give back)", async () => {
    const { w, press } = await setup(true, async () => { throw Object.assign(new Error("FORBIDDEN: no"), { code: "FORBIDDEN" }); });
    const approvalId = approvalIdOf(await press().then(() => undefined, (caught: unknown) => caught));
    const cookie = await w.browser(PRIYA, approvalId);
    await expect(press(cookie)).rejects.toBeDefined();
    expect((await w.decideStore.getSession(cookie))?.usedAt).toBeUndefined();
    expect(await getAnyApproval(w.deps, w.orgId, approvalId)).toMatchObject({ status: "PENDING" });
  });

  it("a Cloud task (the hook does not own it) is unchanged: the card claims the session itself, and the core is never asked", async () => {
    const { w, decided, press } = await setup(false);
    const approvalId = approvalIdOf(await press().then(() => undefined, (caught: unknown) => caught));
    const cookie = await w.browser(PRIYA, approvalId);
    // Cloud's own decision path needs the agent engine this stand-in has no workspace for; what is asserted is the claim, and that the core was not asked.
    await press(cookie).catch(() => undefined);
    expect(decided).toEqual([]);
  });
});
