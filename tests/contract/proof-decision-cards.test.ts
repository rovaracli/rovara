// Decision cards (wire-proof): the routes and the Slack press are mounted behind the cards switch (off by default); the merge cards are built only for a person's OWN tasks from what tracking stored; a press from
// Slack is the real Rovara person or nobody; and a high-risk card has no approve and a merge for a high-risk change (or from Slack or a token) is never made on a click: it is the confirmation page, which asks for a
// sign-in within the last 10 minutes. With the switch off no card path exists, no Slack press is read, and the Lambda answers the press as any unknown button.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DecisionCardsViewSchema, SLACK_OIDC_ISSUER } from "@rovara-code/contracts";
import { editionPolicy, type MergeTrackingItem } from "@agentx/cloud-contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { createCandidateManifest } from "@rovara-code/contracts";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { mergeItemOf, mergeItemsFor, reviewVerdictOf, type MergeSourcePorts } from "../../packages/broker/src/decisions/merge-source.js";
import { projectDecisionCards } from "../../packages/broker/src/decisions/project.js";
import { routeDecisionCards, type DecisionPerformer } from "../../packages/broker/src/decisions/routes.js";
import { createDecisionPerformer, mergeHandler } from "../../packages/broker/src/decisions/performer.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { decisionRouteDepsOf, isDecisionPath } from "../../packages/broker/src/aws/developer-routes/decisions.js";
import { handleSlackDecisionPress, isSlackDecisionPressEvent, slackPersonLookups, slackSignInStands, type SlackDecisionPressEvent, type SlackSignInPolicy } from "../../packages/broker/src/aws/broker/decision-press.js";
import { decisionPressHandler } from "../../packages/broker/src/aws/slack-decision-press.js";
import { DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_OPEN_ACTION } from "../../packages/broker/src/decisions/slack-card.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";

const ORG = "org-1";
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const now = "2026-11-04T12:00:00.000Z";
const CODE = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const HEAD = "a".repeat(40);
const pr = (over: Record<string, unknown> = {}) => ({ repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", state: "OPEN", required: true, candidateDigest: CODE.digest, ...over });
const workflow = (over: Record<string, unknown> = {}): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, definitionVersion: "1.1.0" }),
  stage: "WAIT_FOR_MERGE", state: "WAITING", candidate: CODE,
  checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "r", executable: "pytest", args: [], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] },
  verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: CODE.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
  pullRequests: [pr()], risk: { level: "low", reasons: [], candidateDigest: CODE.digest },
  ...over,
});
const tracking = (over: Partial<MergeTrackingItem> = {}): MergeTrackingItem => ({
  orgId: ORG, taskId, repositoryId: "payments", number: 7, version: 1, headSha: HEAD, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [],
  review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-11-04", count: 0 }, decisionDigest: "d".repeat(64), observedAt: now, ...over,
});
const task = (over: Record<string, unknown> = {}): DeveloperTaskRecord => ({ taskId, ownerKey: "o", workspaceId: "ws", orgId: ORG, project: "payments", title: "Retry failed payments", developerId: "dev-1", developerName: "Dev", provider: "oidc", workflow: workflow(), ...over }) as unknown as DeveloperTaskRecord;

describe("the merge item of a task", () => {
  it("is built from what tracking stored: the heads, the PR's risk, the checks and the reviews; the open path is the session", () => {
    const item = mergeItemOf(task(), workflow(), [tracking()], "ses_1", now);
    expect(item).toMatchObject({ kind: "merge", subjectId: taskId, sessionId: "ses_1", openPath: "/app/sessions/ses_1", prRisk: "low", reviewVerdict: "approved", ci: "passing", heads: [{ repositoryId: "payments", number: 7, headSha: HEAD }], proof: { passed: 1, failed: 0, notTested: 0 } });
  });

  it("is left out whenever it cannot say what merging does: wrong stage, a draft, a closed or untracked pull request, no session, a closed task", () => {
    expect(mergeItemOf(task(), workflow({ stage: "REVIEW" }), [tracking()], "ses_1", now)).toBeUndefined();
    expect(mergeItemOf(task(), workflow({ state: "RUNNING" }), [tracking()], "ses_1", now)).toBeUndefined();
    expect(mergeItemOf(task(), workflow(), [tracking({ draft: true })], "ses_1", now)).toBeUndefined();
    expect(mergeItemOf(task(), workflow(), [tracking({ state: "closed" })], "ses_1", now)).toBeUndefined();
    expect(mergeItemOf(task(), workflow(), [], "ses_1", now)).toBeUndefined();
    expect(mergeItemOf(task(), workflow(), [tracking()], undefined, now)).toBeUndefined();
    expect(mergeItemOf(task({ closedAt: now }), workflow(), [tracking()], "ses_1", now)).toBeUndefined();
    expect(mergeItemOf(task(), { ...workflow(), definitionVersion: "1.0.0" } as never, [tracking()], "ses_1", now)).toBeUndefined();
  });

  it("changes its content version when a head moves or the risk changes, so an earlier 'evidence opened' is worthless", () => {
    const a = mergeItemOf(task(), workflow(), [tracking()], "ses_1", now)!;
    const b = mergeItemOf(task(), workflow(), [tracking({ headSha: "b".repeat(40) })], "ses_1", now)!;
    const c = mergeItemOf(task(), workflow({ risk: { level: "high", reasons: ["Touches IAM."], candidateDigest: CODE.digest } }), [tracking()], "ses_1", now)!;
    expect(new Set([a.contentVersion, b.contentVersion, c.contentVersion]).size).toBe(3);
  });

  it("a pull request someone else pushed to, or one whose risk was judged for other code, is at least medium (never read as low)", () => {
    expect(mergeItemOf(task(), workflow(), [tracking({ headByRovara: false })], "ses_1", now)).toMatchObject({ prRisk: "medium" });
    expect(mergeItemOf(task(), workflow({ risk: { level: "low", reasons: [], candidateDigest: "f".repeat(64) } }), [tracking()], "ses_1", now)).toMatchObject({ prRisk: "medium" });
  });

  it("the reviews in one word: none, every one passed, or one with findings nobody accepted", () => {
    expect(reviewVerdictOf({ ...workflow(), reviews: [] })).toBe("none");
    expect(reviewVerdictOf(workflow())).toBe("approved");
    const finding = { text: "A race.", origin: "INTRODUCED" };
    const withFinding = { ...workflow(), reviews: [{ operationId: randomUUID(), candidateDigest: CODE.digest, role: "SECURITY", provider: "t", version: "1", status: "FINDINGS", findings: [finding], readOnly: true, recordedAt: now }] } as never;
    expect(reviewVerdictOf(withFinding)).toBe("concerns");
  });
});

describe("whose merge cards", () => {
  const rows = [{ taskId, orgId: ORG, status: "OPEN" }, { taskId: "closed-1", orgId: ORG, status: "CLOSED" }, { taskId: "other-org", orgId: "org-2", status: "OPEN" }];
  const ports = (over: Partial<MergeSourcePorts> = {}, tasks: Record<string, DeveloperTaskRecord> = { [taskId]: task({ developerId: "dev-1" }), "other-org": task({ taskId: "other-org", orgId: "org-2", developerId: "dev-1" }) }) => ({
    documentClient: { send: vi.fn(async () => ({ Items: rows })) }, tableName: "t", now: () => Date.parse(now),
    task: async (id: string) => tasks[id], tracking: async () => [tracking()], sessionIdOf: async () => "ses_1", ...over,
  }) satisfies MergeSourcePorts;

  it("only the person's own open tasks, of their own org, that they own now", async () => {
    expect((await mergeItemsFor(ports(), { orgId: ORG, developerId: "dev-1" })).map((item) => item.subjectId)).toEqual([taskId]);
    // Another person asking for the same listing gets nothing of dev-1's task (the owner is dev-1).
    expect(await mergeItemsFor(ports({ documentClient: { send: vi.fn(async () => ({ Items: rows })) } }), { orgId: ORG, developerId: "dev-2" })).toEqual([]);
    // A task whose owner is someone else now (taken over) is not listed for its creator.
    const taken = task({ developerId: "dev-1", currentOwner: { developerId: "dev-2", developerName: "Two", provider: "oidc" } });
    expect(await mergeItemsFor(ports({}, { [taskId]: taken }), { orgId: ORG, developerId: "dev-1" })).toEqual([]);
    expect((await mergeItemsFor(ports({}, { [taskId]: taken }), { orgId: ORG, developerId: "dev-2" }))).toEqual([]);
  });

  it("a task of another org is never listed, whatever its index row says", async () => {
    const rowsOfOtherOrg = [{ taskId: "other-org", orgId: ORG, status: "OPEN" }];
    const foreign = task({ taskId: "other-org", orgId: "org-2", developerId: "dev-1" });
    expect(await mergeItemsFor(ports({ documentClient: { send: vi.fn(async () => ({ Items: rowsOfOtherOrg })) } }, { "other-org": foreign }), { orgId: ORG, developerId: "dev-1" })).toEqual([]);
  });

  it("a task or a session that cannot be read is no card, and the rest still are", async () => {
    const reads = ports({ task: async (id: string) => { if (id === taskId) throw new Error("down"); return undefined; } });
    expect(await mergeItemsFor(reads, { orgId: ORG, developerId: "dev-1" })).toEqual([]);
  });
});

describe("the card routes with the merge performer", () => {
  const item = (risk: "low" | "medium" | "high") => mergeItemOf(task(), workflow({ risk: { level: risk, reasons: risk === "low" ? [] : ["Touches IAM files."], candidateDigest: CODE.digest } }), [tracking()], "ses_1", now)!;
  const world = (risk: "low" | "medium" | "high", press: Parameters<typeof mergeHandler>[0]) => {
    const performer: DecisionPerformer = createDecisionPerformer({ merge: mergeHandler(press) });
    const store = inMemoryDecisionStore(() => Date.parse(now));
    const deps = { sources: { list: async () => [item(risk)], locks: async () => ({}) }, performer, store, now: () => Date.parse(now) };
    const call = (method: string, pathname: string, body?: unknown) => routeDecisionCards(deps, { orgId: ORG, developerId: "dev-1" }, { method, pathname, searchParams: new URLSearchParams(), body });
    return { call };
  };
  const cardId = `merge:${taskId}`;
  const path = (action: string) => `/v1/app/decisions/merge/${taskId}/${action}`;

  it("a low-risk merge is one press that goes through the Merge endpoint with the risk the person saw and the heads the card showed", async () => {
    const press = vi.fn(async () => ({ status: 200 as const, body: { status: "MERGED" as const, pullRequests: [{ repositoryId: "payments", number: 7 }] } }));
    const w = world("low", press);
    const view = DecisionCardsViewSchema.parse((await w.call("GET", "/v1/app/decisions"))?.body);
    expect(view.cards[0]).toMatchObject({ id: cardId, risk: "low" });
    const answer = await w.call("POST", path("approve"), { requestId: randomUUID(), shownDigest: view.digests[cardId] });
    expect(answer?.body).toMatchObject({ outcome: "approved" });
    expect(press).toHaveBeenCalledTimes(1);
    const [, sessionId, body, heads] = press.mock.calls[0] as unknown as [unknown, string, { requestId: string; risk: string }, unknown];
    expect(sessionId).toBe("ses_1");
    expect(body.risk).toBe("low");
    expect(heads).toEqual([{ repositoryId: "payments", number: 7, headSha: HEAD }]);
  });

  it("a high-risk merge card has no approve and no approve route; the confirmation page is the way (a sign-in within the last 10 minutes)", async () => {
    const press = vi.fn(async () => ({ status: 200 as const, body: { status: "MERGED" as const, pullRequests: [] } }));
    const w = world("high", press);
    const view = DecisionCardsViewSchema.parse((await w.call("GET", "/v1/app/decisions"))?.body);
    const card = view.cards[0]!;
    expect(card.risk).toBe("high");
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
    await expect(w.call("POST", path("approve"), { requestId: randomUUID(), shownDigest: view.digests[cardId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(press).not.toHaveBeenCalled();
    // The card says where the decision is made: the item gave no confirmation page, so no fresh sign-in is CLAIMED by the card (it is listed), and the press itself is the endpoint's, which asks for it.
    expect(view.unconfirmed).toContain(cardId);
  });

  it("a press the endpoint answers with the confirmation page decides nothing and is never reported as approved", async () => {
    const press = vi.fn(async () => ({ status: 202 as const, body: { status: "NEEDS_CONFIRMATION" as const, confirmUrl: "https://rovara.example/v1/app/approve/abc" } as never }));
    const w = world("low", press);
    const view = DecisionCardsViewSchema.parse((await w.call("GET", "/v1/app/decisions"))?.body);
    const answer = await w.call("POST", path("approve"), { requestId: randomUUID(), shownDigest: view.digests[cardId] });
    expect(answer?.statusCode).toBe(202);
    expect(answer?.body).toMatchObject({ outcome: "needs_confirmation", confirmUrl: "https://rovara.example/v1/app/approve/abc" });
  });

  it("a medium card cannot be approved before its evidence is opened, and a changed card (a push) must be opened again", async () => {
    const press = vi.fn(async () => ({ status: 200 as const, body: { status: "MERGED" as const, pullRequests: [] } }));
    const w = world("medium", press);
    const view = DecisionCardsViewSchema.parse((await w.call("GET", "/v1/app/decisions"))?.body);
    await expect(w.call("POST", path("approve"), { requestId: randomUUID(), shownDigest: view.digests[cardId] })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(press).not.toHaveBeenCalled();
  });

  it("projects with no spend or plan cards: only the kinds this wiring connects are offered", () => {
    const projection = projectDecisionCards([item("low")], {});
    expect(projection.cards.map((card) => card.kind)).toEqual(["merge"]);
  });
});

describe("the switch", () => {
  const caller = { developerId: "dev-1", orgId: ORG, sessionId: "s", amr: "oidc", name: "Dev", orgRole: "member" } as never;
  const deps = { documentClient: { send: vi.fn() }, tableName: "t", developer: { issuer: "https://rovara.example", signInTableName: "signin" }, now: Date.now, tasks: {}, agents: { agentSessions: { documentClient: { send: vi.fn() }, tableName: "t" } } } as never;

  it("off (unset, 0, anything but exactly 1): no card dependencies exist", () => {
    for (const value of [undefined, "0", "true", "", " 1", "yes"]) expect(decisionRouteDepsOf(deps, caller, value === undefined ? {} : { DECISION_CARDS_ENABLED: value }), JSON.stringify(value)).toBeUndefined();
  });

  it("on, but sessions, tasks or agents are not set up: still none (fail closed)", () => {
    const env = { DECISION_CARDS_ENABLED: "1" };
    expect(decisionRouteDepsOf({ ...(deps as object), agents: undefined } as never, caller, env)).toBeUndefined();
    expect(decisionRouteDepsOf({ ...(deps as object), tasks: undefined } as never, caller, env)).toBeUndefined();
    expect(decisionRouteDepsOf(deps, caller, env)).toBeDefined();
  });

  it("recognises its paths only", () => {
    expect(isDecisionPath("/v1/app/decisions")).toBe(true);
    expect(isDecisionPath(`/v1/app/decisions/merge/${taskId}/approve`)).toBe(true);
    expect(isDecisionPath("/v1/app/decisionsx")).toBe(false);
    expect(isDecisionPath("/v1/app/sessions")).toBe(false);
  });

  it("through the whole broker: the card paths answer not found with the switch off, and with it on where agents are not set up", async () => {
    const harness = await createSingleAnswerPlanBroker();
    for (const on of [false, true]) {
      if (on) process.env.DECISION_CARDS_ENABLED = "1"; else delete process.env.DECISION_CARDS_ENABLED;
      try {
        const list = await harness.dev(MAYA, "GET", "/v1/app/decisions");
        expect(list.status, String(on)).toBe(404);
        const press = await harness.dev(MAYA, "POST", `/v1/app/decisions/merge/${taskId}/approve`, { requestId: randomUUID(), shownDigest: "a".repeat(64) });
        expect(press.status, String(on)).toBe(404);
      } finally { delete process.env.DECISION_CARDS_ENABLED; }
    }
  });
});

describe("a card button pressed in Slack", () => {
  const press = (over: Partial<SlackDecisionPressEvent["press"]> = {}): SlackDecisionPressEvent => ({
    source: "agentx.slack-ingress", action: "decision-card-press",
    press: { actionId: DECISION_SLACK_APPROVE_ACTION, value: `merge:${taskId}|${"a".repeat(64)}`, userId: "U0MAYA", actionTs: "1700000000.000100", messageTs: "1700000000.000001", userTeamId: "T1", workspaceTeamId: "T1", enterpriseId: "", userEnterpriseId: "", ...over },
  });
  const person = (developerId = "dev-1") => ({ developerId, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: "U0MAYA", displayName: "Maya", slackUserId: "U0MAYA", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  const dependencies = { documentClient: { send: vi.fn() }, tableName: "t", developer: { signInTableName: "signin" } } as never;
  const routeDependencies = { documentClient: { send: vi.fn() }, tableName: "t", developer: { signInTableName: "signin", issuer: "https://rovara.example" }, now: Date.now } as never;
  const identityKey = ownerKeyForSubject(SLACK_OIDC_ISSUER, "U0MAYA");

  const NOW_SIGNED_IN = "2026-11-04T10:00:00.000Z";
  const PUBLIC_POLICY = { editionPolicy: editionPolicy("public"), slackOn: true } as const;
  /** The lookups over fakes: who a verified Slack sign-in belongs to and who is a live member of which org; built over the map the handler gives them. */
  const lookups = (over: { link?: string | undefined; row?: ReturnType<typeof person> | undefined; org?: string | undefined; member?: { orgId: string; role: string } | undefined; signedInAt?: string | undefined; policy?: Partial<SlackSignInPolicy> } = {}) => (signedIn: Map<string, never> = new Map<string, never>()) => slackPersonLookups({
    signIn: {
      developerForIdentity: async (key: string) => (key === identityKey && "link" in over ? over.link : key === identityKey ? "dev-1" : undefined),
      getDeveloper: async () => ("row" in over ? over.row : person()) as never,
      getIdentityLink: async () => ("signedInAt" in over ? (over.signedInAt === undefined ? undefined : { lastSignInAt: over.signedInAt }) : { lastSignInAt: NOW_SIGNED_IN }) as never,
    },
    orgs: { orgForSlackTeam: async () => ("org" in over ? over.org : ORG), orgForDeveloper: async () => ("member" in over ? over.member : { orgId: ORG, role: "member" }) as never },
    policy: { ...PUBLIC_POLICY, ...over.policy },
  }, signedIn);

  it("recognises the event and nothing looser", () => {
    expect(isSlackDecisionPressEvent(press())).toBe(true);
    expect(isSlackDecisionPressEvent({ ...press(), requestContext: {} })).toBe(false);
    expect(isSlackDecisionPressEvent({ ...press(), action: "other" })).toBe(false);
    expect(isSlackDecisionPressEvent({ ...press(), press: { ...press().press, userId: 5 } })).toBe(false);
  });

  it("the real person: a verified Slack sign-in that is not revoked, and a live member of the org bound to that install", async () => {
    const l = lookups()();
    expect(await l.linkedDeveloper({ teamId: "T1", userId: "U0MAYA" })).toBe("dev-1");
    expect(await l.orgOfSlackInstall({ teamId: "T1", enterpriseId: "" })).toBe(ORG);
    expect(await l.memberRole(ORG, "dev-1")).toEqual({ orgId: ORG, developerId: "dev-1", orgRole: "member" });
    // Never linked, revoked, or a member of another org: nobody.
    expect(await lookups({ link: undefined })().linkedDeveloper({ teamId: "T1", userId: "U0MAYA" })).toBeUndefined();
    expect(await lookups({ row: { ...person(), revoked: true } })().linkedDeveloper({ teamId: "T1", userId: "U0MAYA" })).toBeUndefined();
    expect(await lookups({ member: { orgId: "org-2", role: "member" } })().memberRole(ORG, "dev-1")).toBeUndefined();
    // A user id other than the one the sign-in identity names has no link (the stand-in identity is never used).
    expect(await l.linkedDeveloper({ teamId: "T1", userId: "U0OTHER" })).toBeUndefined();
  });

  it("holds a Slack press to the sign-in rules every request of a Slack session meets: revoked, ended by an admin, the method off in the install or the edition, turned on again since, and an Auditor outside Enterprise", async () => {
    const stands = async (over: Parameters<typeof lookups>[0]) => (await lookups(over)().linkedDeveloper({ teamId: "T1", userId: "U0MAYA" })) === "dev-1";
    expect(await stands({})).toBe(true);
    expect(await stands({ row: { ...person(), revoked: true } })).toBe(false);
    // An admin ended the person's sign-ins after their last Slack sign-in; a Slack sign-in after that stands again.
    expect(await stands({ row: { ...person(), sessionsEndedAt: "2026-11-04T11:00:00.000Z" } as never })).toBe(false);
    expect(await stands({ row: { ...person(), sessionsEndedAt: "2026-11-04T09:00:00.000Z" } as never })).toBe(true);
    // The install has Slack sign-in off, or the edition does not offer it (Enterprise), or it was turned on again after the last sign-in.
    expect(await stands({ policy: { slackOn: false } })).toBe(false);
    expect(await stands({ policy: { editionPolicy: editionPolicy("enterprise") } })).toBe(false);
    expect(await stands({ policy: { slackSince: Date.parse("2026-11-04T10:30:00.000Z") / 1000 } })).toBe(false);
    expect(await stands({ policy: { slackSince: Date.parse("2026-11-04T09:30:00.000Z") / 1000 } })).toBe(true);
    // A sign-in time that cannot be read fails closed.
    expect(await stands({ signedInAt: "not a time" })).toBe(false);
    // The Auditor is an Enterprise role.
    expect(await lookups({ member: { orgId: ORG, role: "auditor" } })().memberRole(ORG, "dev-1")).toBeUndefined();
    expect(await lookups({ member: { orgId: ORG, role: "auditor" }, policy: { editionPolicy: editionPolicy("enterprise") } })().memberRole(ORG, "dev-1")).toMatchObject({ orgRole: "auditor" });
    expect(slackSignInStands({ revoked: false, lastSignInAt: NOW_SIGNED_IN }, PUBLIC_POLICY)).toBe(true);
  });

  it("a press by a person whose Slack sign-in was revoked or ended by an admin reaches no card route, and the caller of one that does is a Slack sign-in", async () => {
    const env = { DECISION_CARDS_ENABLED: "1" };
    const routed: Array<{ developerId: string; amr?: string }> = [];
    const sources = { list: async () => [], locks: async () => ({}) };
    const run = (l: ReturnType<typeof lookups>) => handleSlackDecisionPress(dependencies, routeDependencies, press(), env, {
      lookupsOf: (map) => l(map as never),
      cardDepsOf: ((_deps: unknown, who: { developerId: string; amr?: string }) => { routed.push(who); return { sources, performer: {} as never, store: inMemoryDecisionStore(), now: Date.now }; }),
    });
    for (const l of [lookups({ row: { ...person(), revoked: true } }), lookups({ row: { ...person(), sessionsEndedAt: "2026-11-04T11:00:00.000Z" } as never }), lookups({ policy: { slackOn: false } }), lookups({ policy: { editionPolicy: editionPolicy("enterprise") } })]) {
      const out = await run(l);
      expect((out as { text: string }).text).toContain("couldn't tell who you are");
    }
    expect(routed).toEqual([]);
    // A person who first signed in another way and linked Slack: the caller is still a Slack sign-in, not their first method.
    await run(lookups({ row: { ...person(), provider: "github" } }));
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ developerId: "dev-1", amr: "slack" });
  });

  it("with the switch off nothing is read and the answer says so", async () => {
    const reads = vi.fn();
    const answer = await handleSlackDecisionPress({ ...(dependencies as object), documentClient: { send: reads } } as never, routeDependencies, press(), {});
    expect(answer).toEqual({ enabled: false });
    expect(reads).not.toHaveBeenCalled();
  });

  it("with the switch on, a press from the real person goes through the card routes as that person, and says only what the route decided", async () => {
    const env = { DECISION_CARDS_ENABLED: "1" };
    const routed: Array<{ developerId: string; orgId: string; browserSession?: true }> = [];
    // The route is the real one; the performer says the endpoint wants the confirmation page, as it does for a Slack press (no browser session).
    const performer = { approve: async () => ({ kind: "needs_confirmation" as const, confirmUrl: "https://rovara.example/v1/app/approve/abc" }), reject: async () => ({ kind: "done" as const }) };
    const item = mergeItemOf(task(), workflow(), [tracking()], "ses_1", now)!;
    const sources = { list: async () => [item], locks: async () => ({}) };
    const digest = DecisionCardsViewSchema.parse((await routeDecisionCards({ sources, performer, store: inMemoryDecisionStore(), now: Date.now }, { orgId: ORG, developerId: "dev-1" }, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body).digests[`merge:${taskId}`]!;
    const run = async (event: SlackDecisionPressEvent, l: ReturnType<typeof lookups>) => handleSlackDecisionPress(dependencies, routeDependencies, event, env, {
      lookupsOf: (map) => l(map as never),
      cardDepsOf: ((_deps: unknown, who: { developerId: string; orgId: string; browserSession?: true }) => { routed.push(who); return { sources, performer, store: inMemoryDecisionStore(), now: Date.now }; }),
    });
    const valueFor = `merge:${taskId}|${digest}`;
    const answer = await run(press({ value: valueFor }), lookups());
    expect(answer).toMatchObject({ enabled: true });
    expect((answer as { text: string }).text).toContain("Nothing was decided yet");
    expect((answer as { text: string }).text).toContain("https://rovara.example/v1/app/approve/abc");
    expect((answer as { text: string }).text).not.toContain("Approved");
    // The route saw the real person, with their live role, and no browser session.
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ developerId: "dev-1", orgId: ORG });
    expect(routed[0]).not.toHaveProperty("browserSession");
    // A Slack Connect guest (the member's workspace is not the one the click came through), an unlinked user, a revoked one and a non-member reach no card route at all.
    routed.length = 0;
    for (const [event, l] of [
      [press({ value: valueFor, userTeamId: "T2" }), lookups()],
      [press({ value: valueFor }), lookups({ link: undefined })],
      [press({ value: valueFor }), lookups({ row: { ...person(), revoked: true } })],
      [press({ value: valueFor }), lookups({ member: undefined })],
      [press({ value: valueFor }), lookups({ org: undefined })],
    ] as const) {
      const out = await run(event, l);
      expect(out).toMatchObject({ enabled: true });
      expect((out as { text: string }).text).toContain("couldn't tell who you are");
    }
    expect(routed).toEqual([]);
  });

  it("the Lambda says what the broker says, says the unknown-button sentence while the switch is off, only acknowledges the link button, and never runs a press it could not hand over", async () => {
    const said: string[] = [];
    const reply = (body: unknown) => ({ statusCode: 200, body: JSON.stringify(body) });
    const base = (invokeBroker: (event: Record<string, unknown>) => Promise<{ statusCode?: number; body?: string }>) => decisionPressHandler({ invokeBroker, respondEphemeral: async (_url, text) => { said.push(text); }, unknownButtonText: "This button is no longer available." });
    const action = (actionId: string) => ({ actionId, value: `merge:${taskId}|${"a".repeat(64)}`, userId: "U0MAYA", userTeamId: "T1", workspaceTeamId: "T1", enterpriseId: "", userEnterpriseId: "", requestStartedAt: 0, thread: {} as never, messageTs: "1", messageText: "", responseUrl: "https://hooks.slack.com/x", triggerId: "t" });
    const off = vi.fn(async () => reply({ enabled: false }));
    await base(off).handle(action(DECISION_SLACK_APPROVE_ACTION));
    expect(said.pop()).toBe("This button is no longer available.");
    const on = vi.fn<(event: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>>(async () => reply({ enabled: true, text: "Nothing was decided yet. Confirm it on the web: https://rovara.example/v1/app/approve/x" }));
    await base(on).handle(action(DECISION_SLACK_APPROVE_ACTION));
    expect(said.pop()).toContain("Nothing was decided yet");
    expect(on.mock.calls[0]![0]).toMatchObject({ source: "agentx.slack-ingress", action: "decision-card-press", press: { userId: "U0MAYA", userTeamId: "T1", workspaceTeamId: "T1" } });
    const link = vi.fn(async () => reply({ enabled: true, text: "x" }));
    await base(link).handle(action(DECISION_SLACK_OPEN_ACTION));
    expect(link).not.toHaveBeenCalled();
    expect(said).toEqual([]);
    // A reply that is not the broker's own shape is the unknown button, never a made-up sentence.
    await base(async () => ({ statusCode: 200, body: "<html>" })).handle(action(DECISION_SLACK_APPROVE_ACTION));
    expect(said.pop()).toBe("This button is no longer available.");
    await base(async () => reply({ enabled: true, text: "x".repeat(601) })).handle(action(DECISION_SLACK_APPROVE_ACTION));
    expect(said.pop()).toBe("This button is no longer available.");
  });
});
