// Approval place (U4): where a coding plan may be decided from, and by whom, enforced by the ONE workflow decision every surface reaches (`decideTaskWorkflow`). With the decision cards on:
//   low: a signed-in browser, a tool or token, Slack or a comment by a LINKED person;
//   medium: a signed-in browser, or Slack / a tracker comment / a pull request comment by a linked person whose last INTERACTIVE Rovara sign-in (email code or company sign-in; a Slack or GitHub sign-in does not count) is inside the
//           company's window; a tool gets the card's link;
//   high: the card in a signed-in browser under the decide-grade sign-in, nothing else;
//   the owner decides; a project maintainer may decide a plan that is not theirs (owner notified, recorded as theirs).
// Each rule has a test that it does not widen anything. The window edge is exact (just inside, just outside).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OrgRole } from "@agentx/cloud-contracts";
import { SLACK_OIDC_ISSUER, type ProjectRole } from "@rovara-code/contracts";
import { orgMetaKey } from "@agentx/cloud-contracts";
import { APPROVAL_WINDOW_SETTING_SK } from "../../packages/broker/src/approval-place/window-setting.js";
import { COMMENT_DECISION_SESSION_ID, decideTaskFromComment } from "../../packages/broker/src/approval-place/comment-decision.js";
import { SLACK_DECISION_SESSION_ID, evaluateApprovalPlace } from "../../packages/broker/src/approval-place/evaluate.js";
import { decideTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks/decide.js";
import { resolveTaskApprover } from "../../packages/broker/src/developer/task-access.js";
import { developerIdentityKey, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { SLACK_WORKFLOW_SESSION_ID } from "../../packages/broker/src/developer/task-records.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { planRunLimitChange } from "../../packages/broker/src/spend/run-limit-change.js";
import { runCostKey } from "@rovara-code/contracts";
import { RUN_LIMIT_OWNER_DECIDES_WORDS } from "../../packages/broker/src/approval-place/words.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const HOUR = 3_600_000;
const CARDS = { DECISION_CARDS_ENABLED: "1" };
beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; });

const INFRA = { claims: [{ id: "1", text: "The payments role may read the retry queue.", evidence: [{ kind: "code" as const, path: "infra/iam/payments-role.tf", startLine: 1, endLine: 9, note: "Today the role cannot read it." }] }] };
const LOW = { document: { claims: [
  { id: "1", text: "A timed-out retry waits longer each time.", evidence: [{ kind: "code" as const, path: "src/retry/backoff.ts", startLine: 1, endLine: 9, note: "Today the wait is fixed." }] },
  { id: "2", text: "A retry is never charged twice." },
] }, checks: { checks: [{ label: "Unit tests", cwd: "repo/demo", executable: "npm", args: ["test"], proves: ["1", "2"] }] } };

type Risk = "low" | "medium" | "high";
type CallerOptions = { role?: OrgRole; browser?: boolean; session?: string; slackUserId?: string };

const PROXY_URL = "http://internal-proxy.example.test:4000";
/** `proxy`: the model proxy is wired, as in a cloud install, so an approval settles the plan's run limit (a raise needs the amount acknowledged, and a tier too low blocks coding until the limit is approved). */
async function world(options: { proxy?: boolean } = {}) {
  const audit = capturingAuditDeps();
  const access = options.proxy === true ? fakeModelAccess() : undefined;
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }) }, audit });
  if (access !== undefined) { access.setMemberSpent(TEST_ORG, MAYA.developerId, 0); access.setOrgSpent(TEST_ORG, 0); }
  /** What earlier runs cost, so a new plan's estimate (and the run limit approving it sets) is large. */
  const seedCosts = (costs: readonly number[]) => costs.forEach((costUsd, index) => {
    const endedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3_600_000).toISOString();
    h.db.set({ ...runCostKey(TEST_ORG, "payments", "rovara-code", "QUICK", endedAt, `task-QUICK-${String(index)}`), entityType: "RUN_COST", orgId: TEST_ORG, project: "payments", agentId: "rovara-code", path: "QUICK", taskId: `task-QUICK-${String(index)}`, endedAt, costUsd });
  });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; orgId: string; budgetUsd?: number; workflow: { revision: number; stage: string; state: string; decisions: Array<Record<string, unknown>>; artifacts: Array<{ sha256: string; type: string }> } };
  const operationWhere = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => String(h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").filter(predicate).at(-1)!.id);
  /** A Quick task of MAYA's with its plan made and waiting; `risk` picks the plan the tier rule reads (a file in infra is high, unproved claims medium, proved and few files low). */
  const planned = async (risk: Risk = "medium", keepBudget = false) => {
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String(meta(taskId).workspaceId);
    await h.finish(workspaceId, operationWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const planning = operationWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
    const document = risk === "high" ? planDocument(INFRA) : risk === "low" ? planDocument(LOW.document) : planDocument();
    await h.artifact(workspaceId, planning, "plan.md", planAnswer(document, risk === "low" ? { checks: LOW.checks } : {}));
    await h.finish(workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    // A high limit already set, so approving raises nothing and needs no acknowledged amount (that rule is not what is under test).
    if (!keepBudget) h.db.set({ ...meta(taskId), budgetUsd: 1000 });
    const workflow = meta(taskId).workflow;
    return { taskId, digest: workflow.artifacts.at(-1)!.sha256, revision: workflow.revision };
  };
  const link = (developerId: string, provider: string, issuer: string, subject: string, lastSignInAt: string, lastAuthTime?: string) => {
    const identityKey = ownerKeyForSubject(issuer, subject);
    const body = { developerId, provider, issuer, subject, linkedAt: "2026-01-01T00:00:00.000Z", lastSignInAt, ...(lastAuthTime === undefined ? {} : { lastAuthTime }) };
    h.db.set({ ...signInIdentityKey(identityKey), entityType: "IDENTITY_LINK", ...body });
    h.db.set({ ...developerIdentityKey(developerId, identityKey), entityType: "IDENTITY_LINK", ...body });
  };
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  /**
   * The person's last sign-in by `provider`, `ms` ago (email code is "cloud", company single sign-on "oidc"/"saml"). A company sign-in also leaves the provider's `auth_time` as `lastAuthTime`: by default as old as the
   * sign-in, `authAgo` a different age (a silent renewal: the sign-in is recent, the person authenticated long ago), or "none" (the provider sent no `auth_time`).
   */
  const signedIn = (who: { developerId: string }, provider: "cloud" | "oidc" | "saml" | "github" | "slack", ms: number, authAgo: number | "none" = ms) =>
    link(who.developerId, provider, provider === "slack" ? SLACK_OIDC_ISSUER : `https://${provider}.example.test`, `${provider}-${who.developerId.slice(0, 6)}`, ago(ms), provider === "oidc" || provider === "saml" ? (authAgo === "none" ? undefined : ago(authAgo)) : undefined);
  /** Maya's verified Slack sign-in (what makes her Slack user LINKED to her), separate from the sign-in that counts as recent. */
  const linkSlack = (who: { developerId: string; slackUserId?: string }, ms = 0) => link(who.developerId, "slack", SLACK_OIDC_ISSUER, who.slackUserId!, ago(ms));
  const setWindow = (seconds: number) => h.db.set({ pk: orgMetaKey(TEST_ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "APPROVAL_WINDOW", orgId: TEST_ORG, revision: 1, seconds });

  const caller = (who: { developerId: string; name: string; sessionId: string; provider: string; slackUserId?: string }, options: CallerOptions = {}) => ({
    orgId: TEST_ORG, developerId: who.developerId, orgRole: options.role ?? "member", name: who.name, amr: who.provider, sessionId: options.session ?? who.sessionId,
    ...(options.browser === true ? { browserSession: true as const } : {}), ...(options.slackUserId === undefined ? {} : { slackUserId: options.slackUserId }),
  }) as never;
  const deps = (projectRole: ProjectRole = "contributor") => ({
    documentClient: h.db, tableName: "state", signInTableName: "signin", actions: h.actions, orgId: TEST_ORG, log: () => undefined, now: () => Date.now(), issuer: DEV_ISSUER, learningAudit: audit.audit, ...(access === undefined ? {} : { modelAccess: access }),
    checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: projectRole }), projectChannelIds: async () => [],
  }) as never;
  const request = (plan: { digest: string; revision: number }, over: Record<string, unknown> = {}) => ({ requestId: randomUUID(), expectedRevision: plan.revision, decision: "APPROVE", reason: "Approved", artifactDigest: plan.digest, ...over });
  /** Decides and answers `ok` or the refusal's code and message. */
  const decide = async (taskId: string, plan: { digest: string; revision: number }, who: never, options: Record<string, unknown> = {}, over: Record<string, unknown> = {}, projectRole: ProjectRole = "contributor") => {
    try {
      await decideTaskWorkflow(deps(projectRole), who, taskId, request(plan, over), options);
      return { ok: true as const };
    } catch (error) {
      const e = error as { code?: string; message?: string; pageReason?: string };
      return { ok: false as const, code: String(e.code), message: String(e.message), pageReason: e.pageReason };
    }
  };
  const decidedAs = (taskId: string) => meta(taskId).workflow.decisions.at(-1) as { decision: string; actorId: string; actorRole: string } | undefined;
  const dms = () => h.db.find((item) => item.entityType === "TASK_ATTENTION_DM");
  const placeEvents = () => audit.recorded().filter((event) => event.action === "approval.place_decided");
  return { h, access, seedCosts, meta, planned, signedIn, linkSlack, setWindow, caller, deps, decide, request, decidedAs, dms, placeEvents, ago };
}
type World = Awaited<ReturnType<typeof world>>;

const mayaChat = (t: World) => t.caller(MAYA, { session: SLACK_DECISION_SESSION_ID, slackUserId: MAYA.slackUserId! });
const mayaBrowser = (t: World) => t.caller(MAYA, { browser: true });
const mayaTool = (t: World) => t.caller(MAYA);
const SIGN_IN_AGAIN = "You can approve it here after you sign in to Rovara again";

describe("medium risk", () => {
  it("a signed-in browser approves it, with no sign-in age asked", async () => {
    const t = await world();
    const plan = await t.planned("medium");
    expect(await t.decide(plan.taskId, plan, mayaBrowser(t))).toEqual({ ok: true });
    expect(t.decidedAs(plan.taskId)).toMatchObject({ decision: "APPROVE", actorRole: "TASK_OWNER" });
  });

  it("a tool, the CLI or an API token (even one of a person who signed in WITH Slack) is told to use the card, and nothing is decided", async () => {
    const t = await world();
    const plan = await t.planned("medium");
    t.linkSlack(MAYA);
    t.signedIn(MAYA, "cloud", HOUR);
    const refused = await t.decide(plan.taskId, plan, mayaTool(t));
    expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining("This plan is medium risk, so it is approved on its card in Rovara") as unknown });
    expect(refused.ok ? "" : refused.message).toContain(`decision=approve_plan%3A${plan.taskId}`);
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
  });

  it("Slack: a linked person who signed in by email code 23 hours ago approves; at 25 hours they are told to sign in again; the answer is recorded for audit with the window and the sign-in's age", async () => {
    const t = await world();
    t.linkSlack(MAYA);
    t.signedIn(MAYA, "cloud", 23 * HOUR);
    const fresh = await t.planned("medium");
    expect(await t.decide(fresh.taskId, fresh, mayaChat(t))).toEqual({ ok: true });
    expect(t.placeEvents()).toHaveLength(1);
    expect(t.placeEvents()[0]).toMatchObject({ target: { kind: "task", id: fresh.taskId }, actor: { id: MAYA.developerId }, facts: { place: "chat", risk: "medium", answer: "approve", role: "owner", windowSeconds: 86_400, signInAgeSeconds: 23 * 3600 } });
    expect(t.dms(), "the owner decided: nobody to tell").toEqual([]);
    const t2 = await world();
    t2.linkSlack(MAYA);
    t2.signedIn(MAYA, "cloud", 25 * HOUR);
    const stale = await t2.planned("medium");
    const refused = await t2.decide(stale.taskId, stale, mayaChat(t2));
    expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining(SIGN_IN_AGAIN) as unknown });
    expect(t2.meta(stale.taskId).workflow.decisions).toEqual([]);
    expect(t2.placeEvents()).toEqual([]);
  });

  it("the window's edge is the company's own: 4 hours refuses a sign-in 5 hours old and accepts one 3 hours old; just inside and just outside", async () => {
    for (const [ms, expected] of [[4 * HOUR - 60_000, true], [4 * HOUR + 60_000, false], [3 * HOUR, true], [5 * HOUR, false]] as const) {
      const t = await world();
      t.linkSlack(MAYA);
      t.setWindow(4 * 3600);
      t.signedIn(MAYA, "cloud", ms);
      const plan = await t.planned("medium");
      const answer = await t.decide(plan.taskId, plan, mayaChat(t));
      expect(answer.ok, `${String(ms / HOUR)} hours old`).toBe(expected);
    }
  });

  it("a lengthened window is honoured: 6 days old is fine inside a 7-day window and refused inside the default", async () => {
    const t = await world();
    t.linkSlack(MAYA);
    t.signedIn(MAYA, "cloud", 6 * 24 * HOUR);
    const plan = await t.planned("medium");
    expect((await t.decide(plan.taskId, plan, mayaChat(t))).ok).toBe(false);
    t.setWindow(7 * 86_400);
    expect((await t.decide(plan.taskId, plan, mayaChat(t))).ok).toBe(true);
  });

  it("a window that cannot be read refuses (the 1-hour minimum), never the default", async () => {
    const t = await world();
    t.linkSlack(MAYA);
    t.signedIn(MAYA, "cloud", 2 * HOUR);
    t.h.db.set({ pk: orgMetaKey(TEST_ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "APPROVAL_WINDOW", orgId: TEST_ORG, revision: 4, seconds: "never" });
    const plan = await t.planned("medium");
    expect(await t.decide(plan.taskId, plan, mayaChat(t))).toMatchObject({ ok: false, message: expect.stringContaining(SIGN_IN_AGAIN) as unknown });
  });

  it("only a Rovara sign-in counts as recent: a Slack or GitHub sign-in alone does not, email code, OIDC and SAML do, an unlinked identity does not (owner answer Q3)", async () => {
    for (const [provider, expected] of [["slack", false], ["github", false], ["cloud", true], ["oidc", true], ["saml", true]] as const) {
      const t = await world();
      t.linkSlack(MAYA, 0);
      t.signedIn(MAYA, provider, HOUR);
      const plan = await t.planned("medium");
      expect((await t.decide(plan.taskId, plan, mayaChat(t))).ok, provider).toBe(expected);
    }
    // The newest counting sign-in wins over an older one; a recent Slack sign-in does not rescue a stale email code.
    const t = await world();
    t.linkSlack(MAYA, 0);
    t.signedIn(MAYA, "cloud", 40 * HOUR);
    t.signedIn(MAYA, "github", HOUR);
    const stale = await t.planned("medium");
    expect((await t.decide(stale.taskId, stale, mayaChat(t))).ok).toBe(false);
    t.signedIn(MAYA, "saml", 2 * HOUR);
    expect((await t.decide(stale.taskId, stale, mayaChat(t))).ok).toBe(true);
  });

  it("a person with no sign-in time at all, or whose Slack account is not linked to them, is refused with the way forward", async () => {
    const t = await world();
    const plan = await t.planned("medium");
    // Linked to Slack but never signed in by a method that counts.
    t.linkSlack(MAYA);
    expect(await t.decide(plan.taskId, plan, mayaChat(t))).toMatchObject({ ok: false, message: expect.stringContaining(SIGN_IN_AGAIN) as unknown });
    // A Slack user id that is not linked to this person (someone else's, or the stand-in of a user who never signed in).
    t.signedIn(MAYA, "cloud", HOUR);
    const other = t.caller(MAYA, { session: SLACK_DECISION_SESSION_ID, slackUserId: "U0OTHER001" });
    expect(await t.decide(plan.taskId, plan, other)).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining("Link your account to Rovara first") as unknown });
    const none = t.caller(MAYA, { session: SLACK_DECISION_SESSION_ID });
    expect(await t.decide(plan.taskId, plan, none)).toMatchObject({ ok: false, message: expect.stringContaining("Link your account to Rovara first") as unknown });
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
  });

  it("M2: a company sign-in counts by the provider's own auth_time, not by the time Rovara saw a sign-in: a silent single sign-on renewal (sign-in 1 hour ago, authenticated 40 hours ago) is not recent, and neither is a provider that sent no auth_time", async () => {
    for (const provider of ["oidc", "saml"] as const) {
      const renewed = await world();
      renewed.linkSlack(MAYA);
      renewed.signedIn(MAYA, provider, HOUR, 40 * HOUR);
      const stale = await renewed.planned("medium");
      expect(await renewed.decide(stale.taskId, stale, mayaChat(renewed)), `${provider} renewal`).toMatchObject({ ok: false, message: expect.stringContaining(SIGN_IN_AGAIN) as unknown });
      expect(renewed.placeEvents()).toEqual([]);
      const none = await world();
      none.linkSlack(MAYA);
      none.signedIn(MAYA, provider, HOUR, "none");
      const noClaim = await none.planned("medium");
      expect((await none.decide(noClaim.taskId, noClaim, mayaChat(none))).ok, `${provider} without auth_time`).toBe(false);
      // A real authentication 2 hours ago (the sign-in itself 1 hour ago) is recent, and the audit record says how old it was.
      const real = await world();
      real.linkSlack(MAYA);
      real.signedIn(MAYA, provider, HOUR, 2 * HOUR);
      const good = await real.planned("medium");
      expect((await real.decide(good.taskId, good, mayaChat(real))).ok, `${provider} authenticated 2 hours ago`).toBe(true);
      expect(real.placeEvents()[0]).toMatchObject({ facts: { signInAgeSeconds: 2 * 3600 } });
    }
    // An email code is a fresh code typed now: the time of the completed sign-in is the time it counts for, with no auth_time involved.
    const code = await world();
    code.linkSlack(MAYA);
    code.signedIn(MAYA, "cloud", HOUR);
    const ok = await code.planned("medium");
    expect((await code.decide(ok.taskId, ok, mayaChat(code))).ok).toBe(true);
    // Neither one rescues the other: a stale company sign-in beside a recent email code is judged by the newest that counts.
    const both = await world();
    both.linkSlack(MAYA);
    both.signedIn(MAYA, "oidc", HOUR, 40 * HOUR);
    both.signedIn(MAYA, "cloud", 3 * HOUR);
    const mixed = await both.planned("medium");
    expect((await both.decide(mixed.taskId, mixed, mayaChat(both))).ok).toBe(true);
    expect(both.placeEvents()[0]).toMatchObject({ facts: { signInAgeSeconds: 3 * 3600 } });
  });

  it("L1: a Slack user who is linked to SOMEONE ELSE is not the pressing person's Slack: the press is refused as not linked", async () => {
    const t = await world();
    t.signedIn(MAYA, "cloud", HOUR);
    t.linkSlack(MAYA);
    // Omar's own Slack account, linked to Omar. A press by Maya that names Omar's Slack user is not Maya's link.
    t.linkSlack({ developerId: OMAR.developerId, slackUserId: "U0OMAR001" });
    const plan = await t.planned("low");
    const claimsOmarsSlack = t.caller(MAYA, { session: SLACK_DECISION_SESSION_ID, slackUserId: "U0OMAR001" });
    expect(await t.decide(plan.taskId, plan, claimsOmarsSlack)).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining("Link your account to Rovara first") as unknown });
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
    expect(await t.decide(plan.taskId, plan, mayaChat(t))).toEqual({ ok: true });
  });

  it("the legacy Slack button's stand-in (a task started in Slack by someone who never signed in) is never recent: medium is refused", async () => {
    const t = await world();
    const plan = await t.planned("medium");
    t.signedIn(MAYA, "cloud", HOUR);
    const standIn = t.caller(MAYA, { session: SLACK_WORKFLOW_SESSION_ID, slackUserId: MAYA.slackUserId! });
    expect(await t.decide(plan.taskId, plan, standIn)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it.each(["tracker-comment", "code-host-comment"] as const)("a %s by a linked person signed in 2 hours ago approves; 30 hours ago they are told to sign in again; an unlinked account is told to link", async (place) => {
    const t = await world();
    const person = { developerId: MAYA.developerId, name: MAYA.name, orgRole: "member" as OrgRole };
    const call = (taskId: string, plan: { digest: string; revision: number }, who: typeof person | undefined) => decideTaskFromComment(() => t.deps("contributor"), { place, orgId: TEST_ORG, taskId, person: who, decision: "APPROVE", body: t.request(plan) }).then(() => ({ ok: true as const }), (error: { code?: string; message?: string }) => ({ ok: false as const, code: error.code, message: error.message }));
    t.signedIn(MAYA, "cloud", 2 * HOUR);
    const good = await t.planned("medium");
    expect(await call(good.taskId, good, person)).toEqual({ ok: true });
    expect(t.decidedAs(good.taskId)).toMatchObject({ decision: "APPROVE", actorRole: "TASK_OWNER" });
    expect(t.placeEvents()[0]).toMatchObject({ facts: { place, risk: "medium", signInAgeSeconds: 2 * 3600 } });
    const t2 = await world();
    t2.signedIn(MAYA, "cloud", 30 * HOUR);
    const old = await t2.planned("medium");
    expect(await decideTaskFromComment(() => t2.deps("contributor"), { place, orgId: TEST_ORG, taskId: old.taskId, person, decision: "APPROVE", body: t2.request(old) }).then(() => "ok", (error: { message: string }) => error.message)).toContain(SIGN_IN_AGAIN);
    const t3 = await world();
    const unlinked = await t3.planned("medium");
    expect(await decideTaskFromComment(() => t3.deps("contributor"), { place, orgId: TEST_ORG, taskId: unlinked.taskId, person: undefined, decision: "APPROVE", body: t3.request(unlinked), link: "https://rovara.example/app" }).then(() => "ok", (error: { message: string }) => error.message)).toBe("FORBIDDEN: Link your account to Rovara first, then try again: https://rovara.example/app");
    expect(t3.meta(unlinked.taskId).workflow.decisions).toEqual([]);
  });

  it("a comment can never reject, and a comment cannot set its own place: the place option is ignored for a caller that is not a comment's", async () => {
    const t = await world();
    const plan = await t.planned("medium");
    const person = { developerId: MAYA.developerId, name: MAYA.name, orgRole: "member" as OrgRole };
    await expect(decideTaskFromComment(() => t.deps(), { place: "code-host-comment", orgId: TEST_ORG, taskId: plan.taskId, person, decision: "REJECT" as never, body: t.request(plan) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(COMMENT_DECISION_SESSION_ID).toBe("comment-decision");
    // The body of a request cannot carry the place: options are server-only, and the strict request schema refuses an unknown field.
    const smuggled = await t.decide(plan.taskId, plan, mayaTool(t), {}, { place: "tracker-comment", commentAuthorLinked: true });
    expect(smuggled.ok).toBe(false);
  });
});

describe("high risk stays in the browser, on the card, under the decide-grade sign-in", () => {
  it("Slack, a comment and a tool are refused with the card's words and link, even for a linked person with a sign-in a minute old", async () => {
    const t = await world();
    t.linkSlack(MAYA);
    t.signedIn(MAYA, "cloud", 60_000);
    const plan = await t.planned("high");
    for (const who of [mayaChat(t), mayaTool(t)]) {
      const refused = await t.decide(plan.taskId, plan, who);
      expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining("This plan is high risk, so it is approved on its card in Rovara, after a sign-in with the email code") as unknown });
    }
    const person = { developerId: MAYA.developerId, name: MAYA.name, orgRole: "member" as OrgRole };
    for (const place of ["tracker-comment", "code-host-comment"] as const) {
      await expect(decideTaskFromComment(() => t.deps(), { place, orgId: TEST_ORG, taskId: plan.taskId, person, decision: "APPROVE", body: t.request(plan) })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("This plan is high risk") as unknown });
    }
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
  });

  it("the browser needs the decide-grade sign-in (its page is sent to the card); with it, the owner approves", async () => {
    const t = await world();
    const plan = await t.planned("high");
    const without = await t.decide(plan.taskId, plan, mayaBrowser(t));
    expect(without).toMatchObject({ ok: false, code: "FORBIDDEN", pageReason: "refused" });
    expect(await t.decide(plan.taskId, plan, mayaBrowser(t), { decideGrade: true })).toEqual({ ok: true });
  });
});

describe("low risk", () => {
  it("a browser, a tool and a linked Slack user approve it; a Slack user who is not linked to the person is told to link", async () => {
    for (const who of [mayaBrowser, mayaTool]) {
      const t = await world();
      const plan = await t.planned("low");
      expect(await t.decide(plan.taskId, plan, who(t))).toEqual({ ok: true });
    }
    const t = await world();
    const plan = await t.planned("low");
    expect(await t.decide(plan.taskId, plan, t.caller(MAYA, { session: SLACK_DECISION_SESSION_ID, slackUserId: MAYA.slackUserId! }))).toMatchObject({ ok: false, message: expect.stringContaining("Link your account to Rovara first") as unknown });
    t.linkSlack(MAYA);
    expect(await t.decide(plan.taskId, plan, mayaChat(t))).toEqual({ ok: true });
  });

  it("the legacy Slack button keeps approving its owner's own LOW plan (the implicit-member path goes with its own switch, not here)", async () => {
    const t = await world();
    const plan = await t.planned("low");
    expect(await t.decide(plan.taskId, plan, t.caller(MAYA, { session: SLACK_WORKFLOW_SESSION_ID, slackUserId: MAYA.slackUserId! }))).toEqual({ ok: true });
  });
});

describe("who may decide", () => {
  /** Omar is a project maintainer who does not own Maya's task. */
  async function maintainerWorld(risk: Risk = "medium") {
    const t = await world();
    const plan = await t.planned(risk);
    const omar = (options: CallerOptions = {}) => t.caller(OMAR, options);
    return { t, plan, omar };
  }

  it("a maintainer who is not the owner approves a plan from the app, the decision is recorded as theirs, the owner is told and the audit says so", async () => {
    const { t, plan, omar } = await maintainerWorld();
    t.linkSlack(MAYA);
    expect(await t.decide(plan.taskId, plan, omar({ browser: true }), {}, {}, "maintainer")).toEqual({ ok: true });
    expect(t.decidedAs(plan.taskId)).toMatchObject({ decision: "APPROVE", actorId: OMAR.developerId, actorRole: "PROJECT_ADMIN" });
    expect(t.meta(plan.taskId).workflow).toMatchObject({ stage: "IMPLEMENT" });
    expect(t.dms()).toHaveLength(1);
    expect(t.dms()[0]).toMatchObject({ status: "PENDING", slackUserId: MAYA.slackUserId });
    expect(String(t.dms()[0]!.text)).toContain(`${OMAR.name} approved the plan for your task "${String(t.meta(plan.taskId).title)}".`);
    expect(t.placeEvents()[0]).toMatchObject({ actor: { id: OMAR.developerId }, facts: { place: "browser", risk: "medium", answer: "approve", role: "maintainer" } });
  });

  it("a maintainer from Slack meets the same place rules: linked and recent, or refused; medium by a tool is the card's link; high is the card", async () => {
    const { t, plan, omar } = await maintainerWorld();
    const chat = omar({ session: SLACK_DECISION_SESSION_ID, slackUserId: "U0OMAR001" });
    t.linkSlack({ developerId: OMAR.developerId, slackUserId: "U0OMAR001" });
    expect(await t.decide(plan.taskId, plan, chat, {}, {}, "maintainer")).toMatchObject({ ok: false, message: expect.stringContaining(SIGN_IN_AGAIN) as unknown });
    expect(await t.decide(plan.taskId, plan, omar(), {}, {}, "maintainer")).toMatchObject({ ok: false, message: expect.stringContaining("This plan is medium risk, so it is approved on its card") as unknown });
    t.signedIn(OMAR, "oidc", 2 * HOUR);
    expect(await t.decide(plan.taskId, plan, chat, {}, {}, "maintainer")).toEqual({ ok: true });
    expect(t.decidedAs(plan.taskId)).toMatchObject({ actorId: OMAR.developerId, actorRole: "PROJECT_ADMIN" });
    const high = await t.planned("high");
    t.signedIn(OMAR, "oidc", 60_000);
    expect(await t.decide(high.taskId, high, chat, {}, {}, "maintainer")).toMatchObject({ ok: false, message: expect.stringContaining("This plan is high risk") as unknown });
    expect(await t.decide(high.taskId, high, omar({ browser: true }), { decideGrade: true }, {}, "maintainer")).toEqual({ ok: true });
  });

  it("a maintainer may also ask for changes (recorded as theirs); a maintainer's reject needs the fresh sign-in the app cannot give yet, so it is refused", async () => {
    const { t, plan, omar } = await maintainerWorld();
    const rejected = await t.decide(plan.taskId, plan, omar({ browser: true }), {}, { decision: "REJECT" }, "maintainer");
    expect(rejected).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
    expect(await t.decide(plan.taskId, plan, omar({ browser: true }), {}, { decision: "REQUEST_CHANGES", reason: "Keep the old export too." }, "maintainer")).toEqual({ ok: true });
    expect(t.decidedAs(plan.taskId)).toMatchObject({ decision: "REQUEST_CHANGES", actorId: OMAR.developerId, actorRole: "PROJECT_ADMIN" });
  });

  it("a contributor, a viewer and a member with no project role read the task as missing, as before", async () => {
    const { t, plan, omar } = await maintainerWorld();
    for (const role of ["contributor", "viewer"] as const) {
      const refused = await t.decide(plan.taskId, plan, omar({ browser: true }), {}, {}, role);
      expect(refused, role).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    }
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
    expect(t.dms()).toEqual([]);
  });

  it("another company's maintainer, and anyone once the cards are off, read the task as missing", async () => {
    const { t, plan, omar } = await maintainerWorld();
    const elsewhere = { ...(omar({ browser: true }) as unknown as Record<string, unknown>), orgId: "org_bbbbbbbbbbbbbbbbbbbb" } as never;
    expect(await t.decide(plan.taskId, plan, elsewhere, {}, {}, "maintainer")).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(t.meta(plan.taskId).workflow.decisions, "nothing was decided under the other company's maintainer").toEqual([]);
    expect(await resolveTaskApprover(t.deps("maintainer"), elsewhere, plan.taskId)).toBeUndefined();
    delete process.env.DECISION_CARDS_ENABLED;
    expect(await t.decide(plan.taskId, plan, omar({ browser: true }), {}, {}, "maintainer")).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(await resolveTaskApprover(t.deps("maintainer"), omar({ browser: true }), plan.taskId)).toBeUndefined();
    process.env.DECISION_CARDS_ENABLED = "1";
    expect(await resolveTaskApprover(t.deps("maintainer"), omar({ browser: true }), plan.taskId)).toMatchObject({ role: "maintainer" });
  });

  it("the owner is never given the maintainer seat, a finished task has none, and a project that cannot be read gives none", async () => {
    const { t, plan, omar } = await maintainerWorld();
    expect(await resolveTaskApprover(t.deps("maintainer"), mayaBrowser(t), plan.taskId)).toBeUndefined();
    const unreadable = { ...(t.deps("maintainer") as unknown as Record<string, unknown>), checkAccess: async () => { throw new Error("down"); } } as never;
    expect(await resolveTaskApprover(unreadable, omar({ browser: true }), plan.taskId)).toBeUndefined();
    t.h.db.set({ ...t.meta(plan.taskId), closedAt: new Date().toISOString() });
    expect(await resolveTaskApprover(t.deps("maintainer"), omar({ browser: true }), plan.taskId)).toBeUndefined();
    expect(await resolveTaskApprover(t.deps("maintainer"), omar({ browser: true }), "not-a-task")).toBeUndefined();
  });

  it("a maintainer cannot decide anything but a coding plan: not 'close as answered', not a skip", async () => {
    const { t, plan, omar } = await maintainerWorld();
    for (const over of [{ decision: "SKIP" }, { artifactDigest: "f".repeat(64) }]) {
      expect(await t.decide(plan.taskId, plan, omar({ browser: true }), {}, over, "maintainer"), JSON.stringify(over)).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    }
    // "Close as answered" is refused too (by the request's own schema for this plan, or by the seat), never decided.
    const closed = await t.decide(plan.taskId, plan, omar({ browser: true }), {}, { closeAsAnswered: true }, "maintainer");
    expect(closed.ok).toBe(false);
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
  });

  it("a replay of the same decision tells nobody twice and writes no second audit record", async () => {
    const { t, plan, omar } = await maintainerWorld();
    t.linkSlack(MAYA);
    const who = omar({ browser: true });
    const requestId = randomUUID();
    expect(await t.decide(plan.taskId, plan, who, {}, { requestId }, "maintainer")).toEqual({ ok: true });
    expect(await t.decide(plan.taskId, plan, who, {}, { requestId }, "maintainer")).toEqual({ ok: true });
    expect(t.dms()).toHaveLength(1);
    expect(t.placeEvents()).toHaveLength(1);
  });
});

describe("M1: an approval that waits only for the run limit's own approval is still recorded", () => {
  it("a medium approval from Slack whose run limit needs a higher tier commits the decision (coding waits) and writes the place audit record, as the other path does", async () => {
    const t = await world({ proxy: true });
    t.seedCosts([10, 10, 10, 10, 10]);
    t.linkSlack(MAYA);
    t.signedIn(MAYA, "cloud", 2 * HOUR);
    const plan = await t.planned("medium", true);
    const change = planRunLimitChange(t.meta(plan.taskId))!;
    expect(change.raises, "positive control: approving raises the limit").toBe(true);
    const answer = await t.decide(plan.taskId, plan, mayaChat(t), {}, { acknowledgedRunLimitUsd: change.proposedUsd });
    expect(answer, JSON.stringify(answer)).toEqual({ ok: true });
    // The early-return path: the decision is recorded and the workflow waits on the limit.
    expect(t.meta(plan.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(t.decidedAs(plan.taskId)).toMatchObject({ decision: "APPROVE" });
    expect(t.placeEvents()).toHaveLength(1);
    expect(t.placeEvents()[0]).toMatchObject({ target: { id: plan.taskId }, facts: { place: "chat", risk: "medium", answer: "approve", role: "owner", windowSeconds: 86_400, signInAgeSeconds: 2 * 3600 } });
  });
});

describe("L3: a maintainer never sets the owner's run limit (money is the owner's)", () => {
  it("a maintainer's decision that carries an acknowledged limit is refused with a plain sentence, with or without the model proxy, and nothing is decided", async () => {
    for (const proxy of [false, true]) {
      const t = await world({ proxy });
      const plan = await t.planned("medium");
      const refused = await t.decide(plan.taskId, plan, t.caller(OMAR, { browser: true }), {}, { acknowledgedRunLimitUsd: 12 }, "maintainer");
      expect(refused, `proxy ${String(proxy)}`).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining(RUN_LIMIT_OWNER_DECIDES_WORDS) as unknown });
      expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
      expect(t.dms()).toEqual([]);
    }
  });

  it("a maintainer's approval that would RAISE the owner's limit is refused even without an amount, so there is nothing to acknowledge; the owner's own approval of the same plan goes on", async () => {
    const t = await world({ proxy: true });
    t.seedCosts([10, 10, 10, 10, 10]);
    const plan = await t.planned("medium", true);
    const change = planRunLimitChange(t.meta(plan.taskId))!;
    expect(change.raises).toBe(true);
    const budgetBefore = t.meta(plan.taskId).budgetUsd;
    const refused = await t.decide(plan.taskId, plan, t.caller(OMAR, { browser: true }), {}, {}, "maintainer");
    expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining(RUN_LIMIT_OWNER_DECIDES_WORDS) as unknown });
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
    expect(t.meta(plan.taskId).budgetUsd, "the owner's limit is untouched").toBe(budgetBefore);
    const owner = await t.decide(plan.taskId, plan, mayaBrowser(t), {}, { acknowledgedRunLimitUsd: change.proposedUsd });
    expect(owner, JSON.stringify(owner)).toEqual({ ok: true });
  });

  it("a maintainer still approves a plan that does not touch the limit (positive control)", async () => {
    const t = await world({ proxy: true });
    const plan = await t.planned("medium");
    expect(await t.decide(plan.taskId, plan, t.caller(OMAR, { browser: true }), {}, {}, "maintainer")).toEqual({ ok: true });
    expect(t.decidedAs(plan.taskId)).toMatchObject({ actorId: OMAR.developerId, actorRole: "PROJECT_ADMIN" });
  });
});

describe("L2: a narrowed People list refuses the maintainer seat", () => {
  const person = (developerId: string, slackUserId: string, role: "owner" | "commenter" | "viewer" | "denied") => ({ developerId, slackUserId, name: "Someone", role });
  const withPeople = async (people: Array<ReturnType<typeof person>>) => {
    const t = await world();
    const plan = await t.planned("medium");
    t.h.db.set({ pk: `DEVTASK#${plan.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people });
    // The Slack-side proof of anyone asked about: eligible and in the channel (so only the list can refuse).
    const checkTaskPerson = async (_task: unknown, developerId: string) => {
      const slackUserId = people.find((entry) => entry.developerId === developerId)?.slackUserId ?? "U0NOONE001";
      return { subject: { developerId, slackUserId }, identity: { developerId, slackUserId, name: "Someone", method: "slack", issuer: "https://slack.com", subject: slackUserId }, eligible: true, channelMember: true };
    };
    const deps = { ...(t.deps("maintainer") as unknown as Record<string, unknown>), checkTaskPerson } as never;
    return { t, plan, deps };
  };

  it("a maintainer the list denies reads the task as missing: no seat, nothing decided", async () => {
    const { t, plan, deps } = await withPeople([person(MAYA.developerId, "U0MAYA001", "owner"), person(OMAR.developerId, "U0OMAR001", "denied")]);
    const omar = t.caller(OMAR, { browser: true });
    expect(await resolveTaskApprover(deps, omar, plan.taskId)).toBeUndefined();
    await expect(decideTaskWorkflow(deps, omar, plan.taskId, t.request(plan))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(t.meta(plan.taskId).workflow.decisions).toEqual([]);
  });

  it("positive control: the same list with the maintainer on it gives the seat, and the People revision the write is fenced on", async () => {
    const { t, plan, deps } = await withPeople([person(MAYA.developerId, "U0MAYA001", "owner"), person(OMAR.developerId, "U0OMAR001", "commenter")]);
    const seat = await resolveTaskApprover(deps, t.caller(OMAR, { browser: true }), plan.taskId);
    expect(seat).toMatchObject({ role: "maintainer", peopleRevision: 3 });
  });

  it("a People list that cannot be read refuses the seat too (fail closed)", async () => {
    const { t, plan, deps } = await withPeople([person(MAYA.developerId, "U0MAYA001", "owner")]);
    t.h.db.set({ pk: `DEVTASK#${plan.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 0, orphaned: false, people: "nobody" });
    expect(await resolveTaskApprover(deps, t.caller(OMAR, { browser: true }), plan.taskId)).toBeUndefined();
  });
});

describe("with the decision cards off, nothing changes", () => {
  it("a tool approves a medium plan and an unlinked Slack user a low one, as before; no maintainer seat", async () => {
    delete process.env.DECISION_CARDS_ENABLED;
    const t = await world();
    const medium = await t.planned("medium");
    expect(await t.decide(medium.taskId, medium, mayaTool(t))).toEqual({ ok: true });
    const low = await t.planned("low");
    expect(await t.decide(low.taskId, low, t.caller(MAYA, { session: SLACK_DECISION_SESSION_ID, slackUserId: "U0NOBODY01" }))).toEqual({ ok: true });
    expect(t.placeEvents()).toEqual([]);
    expect(CARDS.DECISION_CARDS_ENABLED).toBe("1");
  });
});

describe("a failure to read what the rule needs refuses, never approves", () => {
  it("an unreadable sign-in store or window rejects the evaluation (the decision then says to try again)", async () => {
    const down = { send: async () => { throw new Error("down"); } };
    const question = { orgId: TEST_ORG, caller: { developerId: MAYA.developerId, sessionId: SLACK_DECISION_SESSION_ID, slackUserId: MAYA.slackUserId }, kind: "plan" as const, risk: "medium" as const, answer: "approve" as const, place: "chat" as const, role: "owner" as const, freshSignIn: false };
    await expect(evaluateApprovalPlace({ documentClient: down, tableName: "state", signInTableName: "signin", now: () => Date.now() }, question)).rejects.toThrow("down");
    // No sign-in table at all (an install without one): nobody is linked for an outside place, so it is refused, not approved.
    const none = await evaluateApprovalPlace({ documentClient: down, tableName: "state", now: () => Date.now() }, { ...question, risk: "low" });
    expect(none.verdict).toMatchObject({ allowed: false, reason: "not_linked" });
  });
});
