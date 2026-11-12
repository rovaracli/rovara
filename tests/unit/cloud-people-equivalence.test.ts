// Convergence A6 (`cloud/people`): the people adapters give the SAME answers as Cloud's code today. Three-way for every case of the matrix: the Approvers adapter's verdict, today's approval-place evaluation
// (`evaluateApprovalPlace` with the caller each surface builds: the browser session, the decide-grade press, the Slack card press, a token), and the rule as the owner set it (decisions 62, U4, 97: low anywhere by a linked
// person, medium in a browser or from Slack inside the company's window, high and every rejection only in a browser under the fresh sign-in, request changes from anywhere a linked person reaches; owner, co-owner and
// maintainer decide, a collaborator only a low product decision). Then each guard on its own: the Auditor, another company, a stale or spent or someone else's step-up, an unlinked Slack user, the second-person rule
// with the sole-owner exception, and the identity adapter against the routes' own authentication.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@rovara-code/contracts";
import { developerOrgKey, editionPolicy, type ApprovalDeciderRole, type ApprovalDecisionKind, type ApprovalPlace, type ApprovalPlaceAnswer, type ApprovalPlaceRisk } from "@agentx/cloud-contracts";
import {
  API_TOKEN_METHOD, BEARER_SCHEME, BROWSER_SESSION_METHOD, BROWSER_SESSION_SCHEME, BROWSER_STEP_UP_METHOD, CHAT_SLACK_METHOD, CLOUD_APPROVAL_METHODS, PLACE_OF_METHOD,
  cloudApprovalIssuers, createCloudApprovers, createCloudIdentityProvider, type CloudApprovalMethod, type SecondPersonFacts,
} from "../../packages/broker/src/cloud/adapters/people/index.js";
import { SLACK_DECISION_SESSION_ID, evaluateApprovalPlace } from "../../packages/broker/src/approval-place/evaluate.js";
import { secondPersonOutcome } from "../../packages/broker/src/org/approval-by-risk.js";
import { AUDITOR_REFUSED } from "../../packages/broker/src/org/auditor.js";
import { authenticateDeveloper, authenticateDeveloperSessionId } from "../../packages/broker/src/aws/developer-routes/authentication.js";
import { PEOPLE_ORG, createPeopleWorld, type PeopleWorld, type Person } from "../support/cloud-people-world.js";

const HOUR = 3_600_000;
const ROLES: readonly ApprovalDeciderRole[] = ["owner", "co-owner", "maintainer", "contributor", "collaborator", "viewer", "none"];
const RISKS: readonly ApprovalPlaceRisk[] = ["low", "medium", "high"];
const ANSWERS: readonly Exclude<ApprovalPlaceAnswer, "not_now">[] = ["approve", "reject", "request_changes"];
const KINDS: readonly ApprovalDecisionKind[] = ["plan", "product"];
const SIGN_INS = { recent: HOUR, stale: 30 * HOUR, none: undefined } as const;

/** The owner's rule, written out on its own (not read from the code under test). */
function ownerRule(c: { role: ApprovalDeciderRole; kind: ApprovalDecisionKind; place: ApprovalPlace; risk: ApprovalPlaceRisk; answer: string; fresh: boolean; recent: boolean }): boolean {
  const roleOk = c.role === "owner" || c.role === "co-owner" || c.role === "maintainer" || (c.role === "collaborator" && c.kind === "product" && c.risk === "low");
  if (!roleOk) return false;
  if (c.answer === "request_changes") return true;
  if (c.answer === "reject") return c.place === "browser" && c.fresh;
  if (c.risk === "high") return c.place === "browser" && c.fresh;
  if (c.risk === "low") return true;
  if (c.place === "browser") return true;
  if (c.place === "tool") return false;
  return c.recent;
}

const placeDeps = (world: PeopleWorld) => ({ documentClient: world.db, tableName: "state", signInTableName: "signin", now: world.now });

function approversFor(world: PeopleWorld, role: ApprovalDeciderRole | (() => ApprovalDeciderRole), secondPerson?: SecondPersonFacts) {
  return createCloudApprovers({
    issuers: cloudApprovalIssuers({ routes: world.routes, slackLookups: world.slackLookups }),
    deciderRole: async () => (typeof role === "function" ? role() : role),
    place: placeDeps(world),
    ...(secondPerson === undefined ? {} : { secondPerson: async () => secondPerson }),
  });
}

const requestOf = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  companyId: PEOPLE_ORG, requestId: randomUUID(), kind: "plan", subject: { type: "task", id: randomUUID() }, revision: 2, artifactDigest: "b".repeat(64), risk: "low", ...over,
});

async function tokenFor(world: PeopleWorld, method: CloudApprovalMethod, who: Person, request: ApprovalRequest): Promise<string> {
  if (method === BROWSER_SESSION_METHOD) return who.sessionId;
  if (method === BROWSER_STEP_UP_METHOD) return world.stepUp(who, request.subject.id);
  if (method === CHAT_SLACK_METHOD) return world.slackPress(who);
  return world.tokenOf(who);
}

const proofOf = (request: ApprovalRequest, method: string, token: string) => ({ proofId: randomUUID(), method, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token });

/** Today's evaluation, with the caller the surface for this method builds (decide.ts `requirePlanApprovalPlace`). */
async function today(world: PeopleWorld, method: CloudApprovalMethod, who: Person, c: { role: ApprovalDeciderRole; kind: ApprovalDecisionKind; risk: ApprovalPlaceRisk; answer: Exclude<ApprovalPlaceAnswer, "not_now"> }): Promise<boolean> {
  const caller = method === CHAT_SLACK_METHOD ? { developerId: who.developerId, sessionId: SLACK_DECISION_SESSION_ID, slackUserId: who.slackUserId } : { developerId: who.developerId, sessionId: who.sessionId };
  const answer = await evaluateApprovalPlace(placeDeps(world), { orgId: PEOPLE_ORG, caller, kind: c.kind, risk: c.risk, answer: c.answer, place: PLACE_OF_METHOD[method], role: c.role, freshSignIn: method === BROWSER_STEP_UP_METHOD });
  return answer.verdict.allowed;
}

describe("the Approvers adapter answers as today's approval-place rule, for every role, place, risk and answer", () => {
  for (const [signIn, ago] of Object.entries(SIGN_INS)) {
    it(`agrees on all ${String(ROLES.length * CLOUD_APPROVAL_METHODS.length * RISKS.length * ANSWERS.length * KINDS.length)} cases with the last Rovara sign-in ${signIn}`, async () => {
      const world = createPeopleWorld();
      const who = world.people.member;
      world.linkSlack(who);
      world.signedInAgo(who, ago);
      const mismatches: string[] = [];
      let allowed = 0;
      for (const role of ROLES) for (const method of CLOUD_APPROVAL_METHODS) for (const risk of RISKS) for (const answer of ANSWERS) for (const kind of KINDS) {
        const request = requestOf({ kind, risk, outcome: answer });
        const adapter = await approversFor(world, role).verify(request, proofOf(request, method, await tokenFor(world, method, who, request)));
        const baseline = await today(world, method, who, { role, kind, risk, answer });
        const rule = ownerRule({ role, kind, place: PLACE_OF_METHOD[method], risk, answer, fresh: method === BROWSER_STEP_UP_METHOD, recent: signIn === "recent" });
        if (adapter.approved !== baseline || baseline !== rule) mismatches.push(`${role} ${method} ${risk} ${answer} ${kind}: adapter ${String(adapter.approved)}, today ${String(baseline)}, rule ${String(rule)}`);
        if (adapter.approved) allowed += 1;
      }
      expect(mismatches).toEqual([]);
      // The matrix is not vacuous: both answers occur.
      expect(allowed).toBeGreaterThan(0);
      expect(allowed).toBeLessThan(ROLES.length * CLOUD_APPROVAL_METHODS.length * RISKS.length * ANSWERS.length * KINDS.length);
    }, 120_000);
  }

  it("refuses a medium approval from Slack just outside a shortened window and takes it just inside", async () => {
    for (const [ago, expected] of [[HOUR - 60_000, true], [HOUR + 60_000, false]] as const) {
      const world = createPeopleWorld();
      const who = world.people.member;
      world.linkSlack(who);
      world.setWindow(3600);
      world.signedInAgo(who, ago);
      const request = requestOf({ risk: "medium" });
      const verdict = await approversFor(world, "owner").verify(request, proofOf(request, CHAT_SLACK_METHOD, world.slackPress(who)));
      expect(verdict.approved).toBe(expected);
      expect(await today(world, CHAT_SLACK_METHOD, who, { role: "owner", kind: "plan", risk: "medium", answer: "approve" })).toBe(expected);
    }
  });
});

describe("each Cloud guard holds through the adapter", () => {
  it("never lets the Auditor approve, whatever standing the caller reports", async () => {
    const world = createPeopleWorld({ edition: "enterprise" });
    const request = requestOf();
    const verdict = await approversFor(world, "owner").verify(request, proofOf(request, BROWSER_SESSION_METHOD, world.people.auditor.sessionId));
    expect(verdict).toEqual({ approved: false, reason: AUDITOR_REFUSED });
  });

  it("refuses a person of another company with a valid session of their own", async () => {
    const world = createPeopleWorld();
    const request = requestOf();
    expect((await approversFor(world, "owner").verify(request, proofOf(request, BROWSER_SESSION_METHOD, world.people.stranger.sessionId))).approved).toBe(false);
    expect((await approversFor(world, "owner").verify(request, proofOf(request, API_TOKEN_METHOD, world.tokenOf(world.people.stranger)))).approved).toBe(false);
  });

  it("refuses a revoked person and a demoted member's stale token role (the role is read now)", async () => {
    const world = createPeopleWorld();
    const request = requestOf();
    expect((await approversFor(world, "owner").verify(request, proofOf(request, BROWSER_SESSION_METHOD, world.people.revoked.sessionId))).approved).toBe(false);
    const token = world.tokenOf(world.people.owner);
    // The member record and pointer now say Auditor: the token issued as owner does not carry the old role.
    world.db.set({ ...world.db.get(developerOrgKey(world.people.owner.developerId))!, role: "auditor" });
    const verdict = await approversFor(world, "owner").verify(request, proofOf(request, API_TOKEN_METHOD, token));
    expect(verdict.approved).toBe(false);
  });

  it("takes a high-risk approval only with the decide-grade sign-in: fresh, unused, by email code, this person's, for this task", async () => {
    const world = createPeopleWorld();
    const who = world.people.member;
    const high = () => requestOf({ risk: "high" });
    const verify = async (request: ApprovalRequest, token: string) => (await approversFor(world, "owner").verify(request, proofOf(request, BROWSER_STEP_UP_METHOD, token))).approved;
    let request = high();
    expect(await verify(request, await world.stepUp(who, request.subject.id))).toBe(true);
    request = high();
    expect(await verify(request, await world.stepUp(who, request.subject.id, { ageSeconds: 601 }))).toBe(false);
    request = high();
    expect(await verify(request, await world.stepUp(who, request.subject.id, { used: true }))).toBe(false);
    request = high();
    expect(await verify(request, await world.stepUp(who, request.subject.id, { method: "password" }))).toBe(false);
    request = high();
    expect(await verify(request, await world.stepUp(who, randomUUID()))).toBe(false);
    // The owner's decide session presented with the member's browser session.
    request = high();
    const ownerCookie = (await world.stepUp(world.people.owner, request.subject.id)).split(":")[1]!;
    expect(await verify(request, `${who.sessionId}:${ownerCookie}`)).toBe(false);
    // A decide session signed in by someone else, on this person's own card record.
    request = high();
    expect(await verify(request, await world.stepUp(who, request.subject.id, { sessionDeveloperId: world.people.owner.developerId }))).toBe(false);
    // A decide session of another company.
    request = high();
    expect(await verify(request, await world.stepUp(who, request.subject.id, { orgId: world.people.stranger.orgId }))).toBe(false);
    // The same high request from a plain browser session.
    request = high();
    expect((await approversFor(world, "owner").verify(request, proofOf(request, BROWSER_SESSION_METHOD, who.sessionId))).approved).toBe(false);
  });

  it("refuses a Slack press from a user who never linked a Slack sign-in, or from another workspace", async () => {
    const world = createPeopleWorld();
    const who = world.people.member;
    const request = requestOf();
    expect((await approversFor(world, "owner").verify(request, proofOf(request, CHAT_SLACK_METHOD, world.slackPress(who)))).approved).toBe(false);
    expect((await evaluateApprovalPlace(placeDeps(world), { orgId: PEOPLE_ORG, caller: { developerId: who.developerId, sessionId: SLACK_DECISION_SESSION_ID, slackUserId: who.slackUserId }, kind: "plan", risk: "low", answer: "approve", place: "chat", role: "owner", freshSignIn: false })).verdict.allowed).toBe(false);
    world.linkSlack(who);
    const linked = requestOf();
    expect((await approversFor(world, "owner").verify(linked, proofOf(linked, CHAT_SLACK_METHOD, world.slackPress(who)))).approved).toBe(true);
    const elsewhere = requestOf();
    expect((await approversFor(world, "owner").verify(elsewhere, proofOf(elsewhere, CHAT_SLACK_METHOD, world.slackPress(who, { workspaceTeamId: "T0ELSEWHR", userTeamId: "T0ELSEWHR" })))).approved).toBe(false);
  });

  it("applies the second-person rule as approval-by-risk does, with the sole-owner exception and its cool-off", async () => {
    const world = createPeopleWorld();
    const now = world.now();
    const { owner, member } = world.people;
    const cases: Array<{ name: string; proposer: string; approver: Person; eligibility: SecondPersonFacts["eligibility"] }> = [
      { name: "another eligible person", proposer: owner.developerId, approver: member, eligibility: { complete: true, membershipVersion: 3, ownerIds: [owner.developerId], eligibleIds: [owner.developerId, member.developerId], lastEligibleLossAtMs: null } },
      { name: "the proposer, not the sole owner", proposer: member.developerId, approver: member, eligibility: { complete: true, membershipVersion: 3, ownerIds: [owner.developerId], eligibleIds: [owner.developerId, member.developerId], lastEligibleLossAtMs: null } },
      { name: "the sole owner after the cool-off", proposer: owner.developerId, approver: owner, eligibility: { complete: true, membershipVersion: 3, ownerIds: [owner.developerId], eligibleIds: [owner.developerId], lastEligibleLossAtMs: now - 25 * HOUR } },
      { name: "the sole owner inside the cool-off", proposer: owner.developerId, approver: owner, eligibility: { complete: true, membershipVersion: 3, ownerIds: [owner.developerId], eligibleIds: [owner.developerId], lastEligibleLossAtMs: now - HOUR } },
      { name: "an incomplete roster", proposer: owner.developerId, approver: member, eligibility: { complete: false, membershipVersion: 3, ownerIds: [owner.developerId], eligibleIds: [owner.developerId, member.developerId], lastEligibleLossAtMs: null } },
      { name: "an approver outside the eligible list", proposer: owner.developerId, approver: member, eligibility: { complete: true, membershipVersion: 3, ownerIds: [owner.developerId], eligibleIds: [owner.developerId], lastEligibleLossAtMs: null } },
    ];
    for (const c of cases) {
      const facts: SecondPersonFacts = { tier: 1, levels: { tier0: "one", tier1: "two" }, eligibility: c.eligibility, proposerId: c.proposer, placeKind: "design" };
      const request = requestOf({ kind: "lesson" });
      const verdict = await approversFor(world, "maintainer", facts).verify(request, proofOf(request, BROWSER_SESSION_METHOD, c.approver.sessionId));
      const direct = secondPersonOutcome(c.eligibility, c.proposer, c.approver.developerId, now);
      expect(verdict.approved, c.name).toBe(direct.ok);
      if (!direct.ok && !verdict.approved) expect(verdict.reason, c.name).toBe(direct.code);
    }
    const requirement = await approversFor(world, "maintainer", { tier: 2, levels: { tier0: "auto", tier1: "one" }, eligibility: cases[0]!.eligibility, proposerId: owner.developerId, placeKind: "design" }).requirement(requestOf());
    expect(requirement).toMatchObject({ minApprovers: 2, selfApprovalAllowed: false });
  });

  it("names browser-step-up as the only strong and reject method, offers every Cloud method for changes, and sets no sign-in rule of its own", async () => {
    const requirement = await approversFor(createPeopleWorld(), "owner").requirement(requestOf());
    expect(requirement).toEqual({ methods: [...CLOUD_APPROVAL_METHODS], minApprovers: 1, selfApprovalAllowed: true, strongMethods: [BROWSER_STEP_UP_METHOD], rejectMethods: [BROWSER_STEP_UP_METHOD], changesMethods: [...CLOUD_APPROVAL_METHODS] });
  });

  it("refuses a request whose risk is not known, and a kind with no Cloud rule", async () => {
    const world = createPeopleWorld();
    const unknownRisk: ApprovalRequest = requestOf();
    delete unknownRisk.risk;
    expect((await approversFor(world, "owner").verify(unknownRisk, proofOf(unknownRisk, BROWSER_SESSION_METHOD, world.people.member.sessionId))).approved).toBe(false);
    const setting = requestOf({ kind: "setting" });
    expect((await approversFor(world, "owner").verify(setting, proofOf(setting, BROWSER_SESSION_METHOD, world.people.member.sessionId))).approved).toBe(false);
  });
});

describe("the IdentityProvider adapter answers as the routes' own authentication", () => {
  for (const edition of ["public", "enterprise"] as const) {
    it(`gives the same person, company and role as the routes for every person and both credential kinds (${edition})`, async () => {
      const world = createPeopleWorld({ edition });
      const identity = createCloudIdentityProvider(world.routes);
      for (const who of Object.values(world.people)) {
        for (const scheme of [BROWSER_SESSION_SCHEME, BEARER_SCHEME]) {
          const value = scheme === BEARER_SCHEME ? world.tokenOf(who) : who.sessionId;
          const routes = await (scheme === BEARER_SCHEME
            ? world.routes.developer.verifyAccessToken(`Bearer ${value}`).then((claims) => authenticateDeveloper(world.routes, claims))
            : authenticateDeveloperSessionId(world.routes, value)).then((caller) => ({ ok: true as const, caller }), () => ({ ok: false as const }));
          const adapter = await identity.authenticate({ scheme, value });
          expect(adapter.ok, `${who.key} ${scheme}`).toBe(routes.ok);
          if (adapter.ok && routes.ok) {
            expect(adapter.principal).toMatchObject({ companyId: routes.caller.orgId, personId: routes.caller.developerId, roles: [routes.caller.orgRole], provider: routes.caller.amr });
          }
          const direct = await identity.getPrincipal(PEOPLE_ORG, who.developerId);
          expect(direct?.roles, `${who.key} getPrincipal`).toEqual(routes.ok && routes.caller.orgId === PEOPLE_ORG ? [routes.caller.orgRole] : direct === undefined ? undefined : direct.roles);
        }
      }
      // The Auditor is a person only on an edition that has the role; a revoked person and another company's person are nobody here.
      expect((await identity.getPrincipal(PEOPLE_ORG, world.people.auditor.developerId)) !== undefined).toBe(edition === "enterprise" && editionPolicy("enterprise").features.auditorRole);
      expect(await identity.getPrincipal(PEOPLE_ORG, world.people.revoked.developerId)).toBeUndefined();
      expect(await identity.getPrincipal(PEOPLE_ORG, world.people.stranger.developerId)).toBeUndefined();
    });
  }

  it("signs out a browser session whose method was turned off, as the web boundary does", async () => {
    const world = createPeopleWorld();
    const identity = createCloudIdentityProvider(world.routes);
    expect((await identity.authenticate({ scheme: BROWSER_SESSION_SCHEME, value: world.people.owner.sessionId })).ok).toBe(true);
    (world.routes.developer.methods as Record<string, boolean>).oidc = false;
    expect(await identity.authenticate({ scheme: BROWSER_SESSION_SCHEME, value: world.people.owner.sessionId })).toEqual({ ok: false, reason: "expired" });
  });

  it("gives as the sign-in time the last email-code or company sign-in only, never a Slack one", async () => {
    const world = createPeopleWorld();
    const identity = createCloudIdentityProvider(world.routes);
    const who = world.people.member;
    world.linkSlack(who);
    expect((await identity.getPrincipal(PEOPLE_ORG, who.developerId))?.authTime).toBeUndefined();
    world.signedInAgo(who, 2 * HOUR);
    expect((await identity.getPrincipal(PEOPLE_ORG, who.developerId))?.authTime).toBe(new Date(world.now() - 2 * HOUR).toISOString());
  });
});
