// Convergence A6: a small Cloud world for the people adapters (identity, approvers) over the in-memory DynamoDB fake: one company with an owner, a member (with a verified Slack link), an Auditor and a revoked
// person, plus a person of another company. Sessions, developer tokens and the decide-grade sign-in are the real rows Cloud's checks read, so the adapters and today's code read the same data.
import { randomUUID } from "node:crypto";
import { DEVELOPER_TOKEN_AUDIENCE, SLACK_OIDC_ISSUER, singleOrgIdForEnv, type OrgId } from "@rovara-code/contracts";
import { developerOrgKey, editionPolicy, orgMemberKey, orgMetaKey, type EditionPolicy, type OrgRole } from "@agentx/cloud-contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { DeveloperSignInStore, developerIdentityKey, signInIdentityKey, type DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { createPendingChange, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import type { SlackPersonLookups } from "../../packages/broker/src/decisions/slack-actions.js";
import { decideSessionKey } from "../../packages/broker/src/developer/decide-session.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { APPROVAL_WINDOW_SETTING_SK } from "../../packages/broker/src/approval-place/window-setting.js";
import { slackPersonLookups } from "../../packages/broker/src/aws/broker/decision-press.js";
import type { DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ENV, TEST_ORG } from "./orgs.js";

export const PEOPLE_ORG = TEST_ORG;
export const OTHER_ORG: OrgId = singleOrgIdForEnv("people-other");
export const ISSUER = "https://people.example.test/v1/auth";
export const SLACK_TEAM = "T0PEOPLE1";
const HOUR = 3_600_000;

export interface Person { key: string; developerId: string; orgId: OrgId; role: OrgRole; name: string; sessionId: string; amr: "oidc" | "slack" | "cloud"; slackUserId?: string; revoked?: boolean }

const person = (key: string, fill: string, role: OrgRole, extra: Partial<Person> = {}): Person =>
  ({ key, developerId: fill.repeat(64), orgId: PEOPLE_ORG, role, name: `${key[0]!.toUpperCase()}${key.slice(1)} Person`, sessionId: randomUUID(), amr: "oidc", ...extra });

export interface PeopleWorld {
  db: FakeDynamoDb;
  routes: DeveloperRouteDependencies;
  people: Record<"owner" | "member" | "maintainer" | "auditor" | "revoked" | "stranger", Person>;
  now: () => number;
  /** A developer token for a person's session (a fresh random value: no real-looking secret in a fixture). */
  tokenOf(person: Person): string;
  /** The person's last interactive Rovara sign-in (email code), `ms` ago; none when undefined. */
  signedInAgo(person: Person, ms: number | undefined): void;
  /** Seeds a verified Slack sign-in link for the person's Slack user. */
  linkSlack(person: Person): void;
  setWindow(seconds: number): void;
  /** A decide-grade session for a person (and its pending card_decision record), returning the step-up token "<session>:<cookie>". */
  stepUp(person: Person, taskId: string, options?: { ageSeconds?: number; used?: boolean; method?: string; orgId?: OrgId; /** The decide session names someone else while the card record is this person's. */ sessionDeveloperId?: string }): Promise<string>;
  slackPress(person: Person, overrides?: Record<string, string>): string;
  slackLookups: (signedIn: Map<string, DeveloperRecord>) => SlackPersonLookups;
}

export function createPeopleWorld(options: { edition?: EditionPolicy | "public" | "enterprise"; nowMs?: number } = {}): PeopleWorld {
  const db = new FakeDynamoDb();
  const nowMs = options.nowMs ?? Date.parse("2026-11-11T12:00:00.000Z");
  const now = () => nowMs;
  const policy = typeof options.edition === "object" ? options.edition : editionPolicy(options.edition ?? "public");
  const tokens = new Map<string, Record<string, unknown>>();
  const people = {
    owner: person("owner", "a", "owner"),
    member: person("member", "b", "member", { amr: "slack", slackUserId: "U0MEMBER01" }),
    maintainer: person("maintainer", "c", "admin"),
    auditor: person("auditor", "d", "auditor"),
    revoked: person("revoked", "f", "member", { revoked: true }),
    stranger: person("stranger", "9", "owner", { orgId: OTHER_ORG }),
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const org of [PEOPLE_ORG, OTHER_ORG]) db.set({ ...orgMetaKey(org), entityType: "ORG", orgId: org, name: org === PEOPLE_ORG ? TEST_ENV : "other", createdAt: iso(nowMs - 1000 * HOUR), createdBy: "system", plan: "team" });
  let joined = 0;
  for (const who of Object.values(people)) {
    const joinedAt = iso(nowMs - 500 * HOUR + (joined += 1) * 1000);
    db.set({ ...orgMemberKey(who.orgId, who.developerId), entityType: "ORG_MEMBER", orgId: who.orgId, developerId: who.developerId, role: who.role, joinedAt });
    db.set({ ...developerOrgKey(who.developerId), entityType: "DEVELOPER_ORG", orgId: who.orgId, role: who.role, joinedAt });
    db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", entityType: "DEVELOPER", provider: who.amr, issuer: `https://${who.amr}.example.test`, subject: `${who.key}-subject`, displayName: who.name,
      firstSignInAt: iso(nowMs - 400 * HOUR), lastSignInAt: iso(nowMs - 2 * HOUR), revoked: who.revoked === true, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }) });
    const startedAt = iso(nowMs - HOUR);
    db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", entityType: "SESSION", developerId: who.developerId, amr: who.amr, startedAt, authTime: Math.floor((nowMs - HOUR) / 1000),
      endsAt: Math.floor(nowMs / 1000) + 3600, reviewExpiresAt: Math.floor(nowMs / 1000) + 3600 });
  }
  const link = (developerId: string, provider: string, issuer: string, subject: string, lastSignInAt: string) => {
    const identityKey = ownerKeyForSubject(issuer, subject);
    const body = { developerId, provider, issuer, subject, linkedAt: iso(nowMs - 300 * HOUR), lastSignInAt };
    db.set({ ...signInIdentityKey(identityKey), entityType: "IDENTITY_LINK", ...body });
    db.set({ ...developerIdentityKey(developerId, identityKey), entityType: "IDENTITY_LINK", ...body });
  };
  const orgs = new OrgStore({ documentClient: db, tableName: "state", now });
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now });
  const routes = {
    documentClient: db, tableName: "state", now, editionPolicy: policy, orgs,
    developer: {
      issuer: ISSUER, env: TEST_ENV, signInTableName: "signin", slackTeamId: SLACK_TEAM, methods: { slack: true, oidc: true, cloud: true, github: true, saml: true },
      async verifyAccessToken(authorization: string | undefined) {
        const claims = authorization?.startsWith("Bearer ") === true ? tokens.get(authorization.slice("Bearer ".length)) : undefined;
        if (claims === undefined) throw new Error("token not verified");
        return claims;
      },
    },
    agents: { documentClient: db, tableName: "state", now },
  } as unknown as DeveloperRouteDependencies;

  const world: PeopleWorld = {
    db, routes, people, now,
    tokenOf(who) {
      const token = `tok-${randomUUID()}`;
      tokens.set(token, { iss: ISSUER, aud: DEVELOPER_TOKEN_AUDIENCE, env: TEST_ENV, sub: who.developerId, sid: who.sessionId, amr: who.amr, org: who.orgId, org_role: who.role });
      return token;
    },
    signedInAgo(who, ms) {
      if (ms === undefined) return;
      link(who.developerId, "cloud", "https://cloud.example.test", `cloud-${who.key}`, iso(nowMs - ms));
    },
    linkSlack(who) { link(who.developerId, "slack", SLACK_OIDC_ISSUER, who.slackUserId!, iso(nowMs - HOUR)); },
    setWindow(seconds) { db.set({ pk: orgMetaKey(PEOPLE_ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "APPROVAL_WINDOW", orgId: PEOPLE_ORG, revision: 1, seconds }); },
    async stepUp(who, taskId, stepOptions = {}) {
      const cookie = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
      const record = await createPendingChange(routes.agents as ApprovalDependencies, {
        orgId: who.orgId, requestId: randomUUID(), requestedBy: who.developerId,
        subject: { kind: "card_decision", taskId, cardId: `approve_plan:${taskId}`, contentVersion: "v1", returnPath: `/app/tasks/${taskId}` },
        changes: ["Confirm the high-risk decision you pressed on its card."], approvers: { kind: "rule", rule: "card_decision", candidates: [] }, expiresAt: iso(nowMs + 20 * 60_000),
      } as never);
      const signedInAt = Math.floor(nowMs / 1000) - (stepOptions.ageSeconds ?? 60);
      db.set({ ...decideSessionKey(cookie), entityType: "DECIDE_SESSION", orgId: stepOptions.orgId ?? who.orgId, developerId: stepOptions.sessionDeveloperId ?? who.developerId, approvalId: record.approvalId, signedInAt, method: stepOptions.method ?? "email_code",
        csrfHash: "x", expiresAt: signedInAt + 600, ...(stepOptions.used === true ? { usedAt: iso(nowMs) } : {}) });
      return `${who.sessionId}:${cookie}`;
    },
    slackPress(who, overrides = {}) {
      return JSON.stringify({ userId: who.slackUserId ?? "U0NOBODY01", userTeamId: SLACK_TEAM, workspaceTeamId: SLACK_TEAM, enterpriseId: "", userEnterpriseId: "", ...overrides });
    },
    slackLookups: (signedIn) => slackPersonLookups({
      signIn: signInStore,
      orgs: { orgForSlackTeam: async (teamId: string) => (teamId === SLACK_TEAM ? PEOPLE_ORG : undefined), orgForDeveloper: (id: string) => orgs.orgForDeveloper(id) },
      policy: { editionPolicy: policy, slackOn: true },
    }, signedIn),
  };
  return world;
}
