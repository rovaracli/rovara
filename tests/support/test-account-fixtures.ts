// Shared fixtures for the test-account tests (test services TS26 to TS28). Every key-shaped string is built at run time from parts: the public repository's push protection refuses a key-shaped literal.
import { FAKE_BROKER_ROLE_ARN, FakeOrgSecrets } from "./fake-org-secrets.js";
import { FakeTestAccountStore } from "./fake-test-account-store.js";
import { testAccountSecretsPolicyStatements, testAccountSecretsTrustPolicy } from "../../infra/lib/test-account-secrets-policy.js";
import { TestAccountSecrets } from "../../packages/broker/src/test-env/test-account-secrets.js";
import type { TestAccountCaller, TestAccountDeps } from "../../packages/broker/src/test-env/test-accounts.js";
import { agentXError, type TestEnvProdDeny } from "@agentx/contracts";

export const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
export const OTHER_ORG = `org_${"z9y8x7w6v5".repeat(2)}`;
export const person = (letter: string): string => letter.repeat(64);
export const [ADMIN_A, ADMIN_B, ADMIN_C] = [person("a"), person("b"), person("c")] as const;
export const ROLE_ARN = "arn:aws:iam::111122223333:role/test-account-secrets-role";
export const ARN_PREFIX = "arn:aws:secretsmanager:us-west-2:111122223333:secret:";
export const T0 = Date.parse("2026-11-02T12:00:00.000Z");

export const build = (...parts: string[]): string => parts.join("");
export const rand = (length: number): string => "Qk7mP2xR9vLw4NtY8bZc3HdF6gJs1VaUeXoI5".repeat(3).slice(0, length);
/** A test-mode key of the payment provider whose keys carry their mode. */
export const stripeTest = (): string => build("sk", "_", "test", "_", rand(24));
export const stripeLive = (): string => build("sk", "_", "live", "_", rand(24));

export const apiDraft = (over: Record<string, unknown> = {}) => ({
  label: "Payments test mode", kind: "api_key" as const, family: "http:api.stripe.com", hosts: ["api.stripe.com"], envNames: ["PAYMENTS_API_KEY"], projectIds: ["orders", "billing"] as string[], ...over,
});
export const awsDraft = (over: Record<string, unknown> = {}) => ({
  label: "Dev AWS (orders)", kind: "aws_role" as const, family: "aws:dynamodb", projectIds: ["orders"] as string[],
  aws: { roleArn: "arn:aws:iam::222233334444:role/rovara-test", externalId: "ext-0123456789", region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: ["arn:aws:dynamodb:us-west-2:222233334444:table/orders-test"] },
  ...over,
});

export interface Harness {
  deps: TestAccountDeps;
  store: FakeTestAccountStore;
  secrets: FakeOrgSecrets;
  secretsClass: TestAccountSecrets;
  clock: { now: number };
  sessions: Map<string, { developerId: string; authTime?: string; revokedAt?: string }>;
  admins: Set<string>;
  eligible: { ids: string[]; owners: string[]; lastLossAt: number | null };
  state: { enabled: boolean; soleOwnerAllowed: boolean; maxDays: number; deny: TestEnvProdDeny };
  calls: string[];
  caller(developerId: string, over?: Partial<TestAccountCaller>): TestAccountCaller;
}

export function harness(over: { enabled?: boolean } = {}): Harness {
  const clock = { now: T0 };
  const secrets = new FakeOrgSecrets({
    env: "staging", roleArn: ROLE_ARN, now: () => clock.now,
    policy: testAccountSecretsPolicyStatements({ secretArnPrefix: ARN_PREFIX, env: "staging" }),
    trust: testAccountSecretsTrustPolicy(FAKE_BROKER_ROLE_ARN).Statement,
  });
  const secretsClass = new TestAccountSecrets({ env: "staging", roleArn: ROLE_ARN, secretArnPrefix: ARN_PREFIX, region: "us-west-2", sts: secrets.sts, storeClientFor: (credentials) => secrets.secretsFor(credentials), now: () => clock.now });
  const store = new FakeTestAccountStore();
  const sessions = new Map<string, { developerId: string; authTime?: string; revokedAt?: string }>();
  const admins = new Set<string>([ADMIN_A, ADMIN_B, ADMIN_C]);
  const eligible = { ids: [ADMIN_A, ADMIN_B, ADMIN_C], owners: [ADMIN_A], lastLossAt: null as number | null };
  const state = { enabled: over.enabled ?? true, soleOwnerAllowed: true, maxDays: 90, deny: { accountIds: ["999900009999"], hosts: ["*.prod.example.com"], arnPrefixes: [] } as TestEnvProdDeny };
  const calls: string[] = [];
  let counter = 0;
  const deps: TestAccountDeps = {
    env: "staging",
    enabled: () => state.enabled,
    store,
    secrets: secretsClass,
    requireAdmin: (who) => { calls.push("requireAdmin"); return admins.has(who.developerId) ? Promise.resolve() : Promise.reject(agentXError("FORBIDDEN", "not an admin")); },
    readSession: (id) => { calls.push("readSession"); return Promise.resolve(sessions.get(id)); },
    approvalEvidence: ({ orgId, proposerId, approverId }) => {
      calls.push("approvalEvidence");
      return Promise.resolve({
        decisionInput: { proposerId, approverId, nowMs: clock.now, complete: true, membershipVersion: 3, ownerIds: eligible.owners, eligibleIds: eligible.ids, lastEligibleLossAtMs: eligible.lastLossAt },
        conditions: [{ ConditionCheck: { TableName: "state", Key: { pk: `ORG#${orgId}`, sk: "META" }, ConditionExpression: "attribute_exists(pk)" } }],
      });
    },
    soleOwnerExceptionAllowed: () => Promise.resolve(state.soleOwnerAllowed),
    prodDeny: () => Promise.resolve(state.deny),
    rovaraAccountIds: () => ["888800008888"],
    maxExpiryDays: () => Promise.resolve(state.maxDays),
    now: () => new Date(clock.now),
    newSuffix: () => String(++counter).padStart(16, "0"),
  };
  const caller = (developerId: string, extra: Partial<TestAccountCaller> = {}): TestAccountCaller => {
    const sessionId = `session-${developerId.slice(0, 4)}`;
    // A caller always has a sign-in a minute old, as of the clock's now; a test that wants another session sets it AFTER calling this.
    sessions.set(sessionId, { developerId, authTime: new Date(clock.now - 60_000).toISOString() });
    return { orgId: ORG, developerId, sessionId, ...extra };
  };
  return { deps, store, secrets, secretsClass, clock, sessions, admins, eligible, state, calls, caller };
}
