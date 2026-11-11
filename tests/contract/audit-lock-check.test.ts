// tests/contract/audit-lock-check.test.ts
// Task 9 of the Audit Ledger plan: Object Lock enforcement and drift. The floor is in code (`lockFloor`), never from deploy
// values; every sealed object is read back with HeadObject by its version id before its org is finalized; each run checks the
// bucket's default retention, its versioning and its policy hash; a sweep looks for delete markers and extra versions on
// sealed keys. S3 is FakeLockedS3 (it answers the configuration reads from fields a test can change), DynamoDB is FakeDynamoDb.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AUDIT_VERSION_SWEEP_KEYS_PER_RUN } from "@agentx/cloud-contracts";
import { ENVIRONMENT_PLACEHOLDER } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import type { AuditLedger } from "../../infra/lib/audit-ledger.js";
import { auditLockSettings } from "../../infra/lib/audit-settings.js";
import { defaultAuditLockProfile } from "../../packages/cli/src/deploy/answer-schemas.js";
import { AUDIT_LOCK_DRIFT_EVENTS } from "../../infra/lib/audit-ledger.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { recordsObjectKey, sealObjectKey, statementObjectKey } from "../../packages/broker/src/audit/anchor.js";
import {
  bucketPolicyHash,
  checkLockDrift,
  currentFloor,
  enforceObjectLock,
  lockFloor,
  lockSettingsFromEnvironment,
  normalizeBucketPolicy,
  sweepSealedVersions,
  type LockFloor,
} from "../../packages/broker/src/audit/lock-check.js";
import {
  A, ACCOUNT, B, BUCKET, C, E0, E1, PARTITION, REGION, START, at, appendRecords, bucketPolicyText, epochHead, eventsOf, harness, intentOf, metaOf, run, stateOf, type Harness,
} from "../support/audit-anchor-harness.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const DAY = 86_400_000;
/** A matcher for a nested object that has at least these members. */
const like = (value: Record<string, unknown>): unknown => expect.objectContaining(value) as unknown;
const mismatches = (h: Harness) => eventsOf(h, "audit.lock_config_mismatch");
const drifts = (h: Harness) => eventsOf(h, "audit.version_drift");
const lockLogs = (h: Harness) => h.logs.filter((entry) => entry.event === "audit.lock_config_mismatch" || entry.event === "audit.version_drift");
const policyContext = (envName: string) => ({ envName, partition: PARTITION, accountId: ACCOUNT, region: REGION });

describe("lockFloor: in code, from the environment's name, the profile and the ratchet", () => {
  it("is governance for one day for staging, test and dev*, whatever the profile says", () => {
    for (const env of ["staging", "test", "dev", "dev-eu", "dev-a-b"]) {
      for (const profile of ["production", "trial"] as const) expect(lockFloor(env, profile), `${env} ${profile}`).toStrictEqual({ mode: "GOVERNANCE", days: 1 });
    }
  });

  it("is compliance for 365 days for every other name under the production profile (the default)", () => {
    for (const env of ["production", "acme", "ops-team", "stagingx", "tester"]) {
      expect(lockFloor(env), env).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
      expect(lockFloor(env, "production"), env).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
    }
  });

  it("knows the test names exactly: staging, test, dev, or dev-<suffix>, and nothing that merely starts with dev", () => {
    for (const env of ["devices", "devco", "development", "dev-", "dev_eu", "Dev", "staging-eu", "testing", "stagin"]) {
      expect(lockFloor(env), env).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
      expect(lockFloor(env, "production"), env).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
    }
    // The infrastructure and the CLI use the same rule.
    for (const env of ["devices", "devco", "dev", "dev-eu", "staging", "test", "acme"]) {
      const { floor } = auditLockSettings(environmentNaming(env), {});
      expect(lockFloor(env, floor.mode === "GOVERNANCE" ? "trial" : "production"), env).toStrictEqual(floor);
      expect(defaultAuditLockProfile(env), env).toBe(floor.mode === "GOVERNANCE" ? "trial" : "production");
    }
  });

  it("lets a trial install (profile trial) run governance for one day under any name", () => {
    for (const env of ["production", "acme"]) expect(lockFloor(env, "trial"), env).toStrictEqual({ mode: "GOVERNANCE", days: 1 });
  });

  it("is compliance once the ratchet is set, whatever the profile says", () => {
    for (const profile of ["production", "trial"] as const) {
      expect(lockFloor("acme", profile, true), profile).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
      expect(lockFloor("production", profile, true), profile).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
    }
    // A test name keeps its one day, but not its governance.
    expect(lockFloor("staging", "trial", true)).toStrictEqual({ mode: "COMPLIANCE", days: 1 });
  });

  it("is never lowered by the environment's name once the ratchet recorded its days: a test name after a 365-day ratchet still needs 365", () => {
    for (const env of ["staging", "test", "dev", "dev-eu"]) {
      for (const profile of ["production", "trial"] as const) expect(lockFloor(env, profile, true, 365), `${env} ${profile}`).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
    }
    // A test name's own ratchet keeps its one day; a stored value above the name's floor wins, one below it does not.
    expect(lockFloor("staging", "trial", true, 1)).toStrictEqual({ mode: "COMPLIANCE", days: 1 });
    expect(lockFloor("acme", "production", true, 1096)).toStrictEqual({ mode: "COMPLIANCE", days: 1096 });
    expect(lockFloor("acme", "production", true, 30)).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
    for (const garbage of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(lockFloor("acme", "trial", true, garbage), String(garbage)).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
  });

  it("agrees with the floor the infrastructure refuses to synthesize below", () => {
    for (const env of ["staging", "test", "dev", "dev-eu", "production", "acme", "ops-team"]) {
      const { floor } = auditLockSettings(environmentNaming(env), {});
      expect(lockFloor(env, floor.mode === "GOVERNANCE" ? "trial" : "production"), env).toStrictEqual(floor);
    }
  });
});

describe("lockSettingsFromEnvironment", () => {
  const environment = {
    AUDIT_ENV_NAME: "acme", AUDIT_LOCK_PROFILE: "production", AUDIT_LOCK_MODE: "COMPLIANCE", AUDIT_RETENTION_DAYS: "1096",
    AUDIT_BUCKET_POLICY_SHA256: "a".repeat(64), AUDIT_PARTITION: "aws", AUDIT_ACCOUNT_ID: "123456789012", AWS_REGION: "us-east-1",
  };

  it("reads the deployed values", () => {
    expect(lockSettingsFromEnvironment(environment)).toStrictEqual({
      envName: "acme", profile: "production", deployed: { mode: "COMPLIANCE", days: 1096 }, bucketPolicySha256: "a".repeat(64), partition: "aws", accountId: "123456789012", region: "us-east-1",
    });
  });

  it("refuses a missing or malformed value instead of running without a check", () => {
    for (const name of Object.keys(environment)) expect(() => lockSettingsFromEnvironment({ ...environment, [name]: undefined }), name).toThrow(name);
    expect(() => lockSettingsFromEnvironment({ ...environment, AUDIT_LOCK_PROFILE: "relaxed" })).toThrow(/AUDIT_LOCK_PROFILE/);
    expect(() => lockSettingsFromEnvironment({ ...environment, AUDIT_LOCK_MODE: "NONE" })).toThrow(/AUDIT_LOCK_MODE/);
    expect(() => lockSettingsFromEnvironment({ ...environment, AUDIT_RETENTION_DAYS: "many" })).toThrow(/AUDIT_RETENTION_DAYS/);
    expect(() => lockSettingsFromEnvironment({ ...environment, AUDIT_BUCKET_POLICY_SHA256: "not-a-hash" })).toThrow(/AUDIT_BUCKET_POLICY_SHA256/);
  });
});

describe("the bucket policy hash (Task 5 hand-off): the live document, normalized, equals the synthesized hash", () => {
  type Json = Record<string, unknown>;
  type Template = { Resources: Record<string, { Type: string; Properties: Json }>; Parameters: Record<string, { Default: string }>; Conditions: Record<string, unknown> };
  function synth(context: Record<string, unknown>) {
    const app = buildAgentXApp(context);
    const stack = app.node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.node.tryFindChild("AuditLedger") !== undefined)!;
    return { template: Template.fromStack(stack).toJSON() as Template, ledger: stack.node.findChild("AuditLedger") as AuditLedger };
  }
  /** What S3 would return for the deployed stack: the template's bucket policy under the profile, with this account, region and partition. */
  function livePolicy(synthesis: ReturnType<typeof synth>, profile: "production" | "trial"): { document: Json; text: string } {
    const [, policy] = Object.entries(synthesis.template.Resources).find(([id, resource]) => resource.Type === "AWS::S3::BucketPolicy" && id.startsWith("AuditLedgerAuditLedgerBucketPolicy"))!;
    const document = evaluate(policy.Properties.PolicyDocument, {
      parameters: { AuditLockProfile: profile }, conditions: synthesis.template.Conditions,
      pseudo: { "AWS::AccountId": ACCOUNT, "AWS::Region": REGION, "AWS::Partition": PARTITION },
    }) as Json;
    return { document, text: JSON.stringify(document) };
  }
  /** The same policy the way S3 may store and return it: `"*"` principals, one-element lists collapsed or expanded, keys reordered, pretty printed. */
  function reserialized(document: Json, style: "collapsed" | "expanded"): string {
    const shuffle = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffle);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Json).reverse().map(([key, entry]) => [key, shuffle(entry)]));
    };
    const statements = (document.Statement as Json[]).map((statement) => {
      const next: Json = { ...statement };
      if (JSON.stringify(next.Principal) === JSON.stringify({ AWS: "*" })) next.Principal = "*";
      for (const field of ["Action", "Resource"]) {
        const value = next[field];
        if (style === "expanded" && typeof value === "string") next[field] = [value];
        if (style === "collapsed" && Array.isArray(value) && value.length === 1) next[field] = value[0];
      }
      return next;
    });
    return JSON.stringify(shuffle({ ...document, Statement: statements }), null, 2);
  }

  for (const env of ["production", "acme", "staging"]) {
    const synthesis = synth({ agentxEnv: env });
    for (const profile of ["production", "trial"] as const) {
      const expected = synthesis.ledger.bucketPolicySha256ByProfile[profile];

      it(`${env} under ${profile}: the policy S3 holds, with this account's ARNs, hashes to the synthesized hash`, () => {
        const { document, text } = livePolicy(synthesis, profile);
        expect(text).toContain(ACCOUNT);
        expect(text).not.toContain("{{");
        expect(bucketPolicyHash(text, policyContext(env))).toBe(expected);
        // Through the document the way DescribeStacks and the AWS SDK parse it.
        expect(bucketPolicyHash(JSON.stringify(document, null, 4), policyContext(env))).toBe(expected);
      });

      it(`${env} under ${profile}: S3's own serialization (collapsed or expanded lists, "*" principals, other key order) gives the same hash`, () => {
        const { document } = livePolicy(synthesis, profile);
        expect(bucketPolicyHash(reserialized(document, "collapsed"), policyContext(env))).toBe(expected);
        expect(bucketPolicyHash(reserialized(document, "expanded"), policyContext(env))).toBe(expected);
      });

      it(`${env} under ${profile}: any edit of the document changes the hash`, () => {
        const { document } = livePolicy(synthesis, profile);
        const statements = document.Statement as Json[];
        const edited = (change: (copy: Json[]) => Json[]) => bucketPolicyHash(JSON.stringify({ ...document, Statement: change(structuredClone(statements)) }), policyContext(env));
        expect(edited((copy) => copy.slice(1))).not.toBe(expected);
        expect(edited((copy) => copy.map((statement, index) => (index === 0 ? { ...statement, Effect: "Allow" } : statement)))).not.toBe(expected);
        expect(edited((copy) => [...copy, { Sid: "Extra", Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*" }])).not.toBe(expected);
        expect(edited((copy) => copy.map((statement) => JSON.parse(JSON.stringify(statement).replace(/"(\d+)"/, '"7"')) as Json))).not.toBe(expected);
        // A document for another account is not this deployment's document.
        expect(bucketPolicyHash(JSON.stringify(document).replaceAll(ACCOUNT, "999999999999"), policyContext(env))).not.toBe(expected);
      });
    }
  }

  it("does not depend on the environment's name, so a published template (hashed for the placeholder name) still matches once rendered", () => {
    const placeholder = synth({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxAuditLockMode: "COMPLIANCE", agentxAuditRetentionDays: 1096 });
    const acme = synth({ agentxEnv: "acme" });
    const other = synth({ agentxEnv: "ops-team" });
    expect(placeholder.ledger.bucketPolicySha256ByProfile.production).toBe(acme.ledger.bucketPolicySha256ByProfile.production);
    expect(other.ledger.bucketPolicySha256ByProfile.production).toBe(acme.ledger.bucketPolicySha256ByProfile.production);
    // And the profiles still differ.
    expect(acme.ledger.bucketPolicySha256ByProfile.trial).not.toBe(acme.ledger.bucketPolicySha256ByProfile.production);
    // The live document of an install rendered from the placeholder's template is the acme document.
    const { text } = livePolicy(acme, "production");
    expect(bucketPolicyHash(text, policyContext("acme"))).toBe(placeholder.ledger.bucketPolicySha256ByProfile.production);
  });

  it("normalizes to placeholders and refuses what is not a policy document", () => {
    const text = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "X", Effect: "Deny", Principal: { AWS: ["*"] }, Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::agentx-acme-audit-ledger-${ACCOUNT}-${REGION}/*`] }] });
    expect(normalizeBucketPolicy(text, policyContext("acme"))).toStrictEqual({
      Version: "2012-10-17",
      Statement: [{ Sid: "X", Effect: "Deny", Principal: { AWS: "*" }, Action: "s3:GetObject", Resource: "arn:{{partition}}:s3:::agentx-{{env}}-audit-ledger-{{account}}-{{region}}/*" }],
    });
    expect(() => normalizeBucketPolicy("not json", policyContext("acme"))).toThrow(/policy/);
    expect(() => normalizeBucketPolicy("[]", policyContext("acme"))).toThrow(/policy/);
  });
});

describe("checkLockDrift (each run)", () => {
  it("logs nothing for a clean bucket, and reports it fit to finalize", async () => {
    const h = harness();
    const status = await checkLockDrift(h.deps, START);
    expect(status).toStrictEqual({ ok: true, floor: { mode: "COMPLIANCE", days: 365 }, ratcheted: true });
    expect(h.logs).toStrictEqual([]);
  });

  it("holds a production name to compliance for 365 days even when its deploy values say governance for 30", async () => {
    const h = harness({ retention: { mode: "GOVERNANCE", days: 30 }, profile: "production", deployed: { mode: "GOVERNANCE", days: 30 } });
    const status = await checkLockDrift(h.deps, START);
    expect(status).toMatchObject({ ok: false, floor: { mode: "COMPLIANCE", days: 365 } });
    expect(mismatches(h)).toContainEqual(expect.objectContaining({
      level: "error", check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "GOVERNANCE", days: 30 },
    }));
  });

  it("holds compliance to the 365-day floor", async () => {
    const h = harness({ retention: { mode: "COMPLIANCE", days: 200 } });
    expect(await checkLockDrift(h.deps, START)).toMatchObject({ ok: false });
    expect(mismatches(h)[0]).toMatchObject({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "COMPLIANCE", days: 200 } });
    const exact = harness({ retention: { mode: "COMPLIANCE", days: 365 } });
    expect(await checkLockDrift(exact.deps, START)).toMatchObject({ ok: true });
  });

  it("accepts governance for one day for a trial install, under any name, and for staging, test and dev*", async () => {
    for (const [envName, profile] of [["acme", "trial"], ["staging", "production"], ["test", "production"], ["dev-eu", "trial"]] as const) {
      const h = harness({ envName, profile, retention: { mode: "GOVERNANCE", days: 1 } });
      expect(await checkLockDrift(h.deps, START), `${envName} ${profile}`).toMatchObject({ ok: true, floor: { mode: "GOVERNANCE", days: 1 }, ratcheted: false });
      expect(h.logs, `${envName} ${profile}`).toStrictEqual([]);
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toBeUndefined();
    }
  });

  it("refuses governance for a name that is neither a test name nor a trial profile", async () => {
    const h = harness({ envName: "production", profile: "production", retention: { mode: "GOVERNANCE", days: 1 } });
    expect(await checkLockDrift(h.deps, START)).toMatchObject({ ok: false });
    expect(mismatches(h)[0]).toMatchObject({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "GOVERNANCE", days: 1 } });
  });

  describe("the one-way ratchet (controller ruling 1)", () => {
    it("writes a marker the first time it sees COMPLIANCE, with the floor's days and the bucket's name, once, and never moves it", async () => {
      const h = harness();
      await checkLockDrift(h.deps, START);
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toStrictEqual({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, bucket: BUCKET, since: new Date(START).toISOString() });
      await checkLockDrift(h.deps, at(10));
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ mode: "COMPLIANCE", days: 365, bucket: BUCKET, since: new Date(START).toISOString() });
    });

    it("records a test name's own days (one) when that is its floor", async () => {
      const h = harness({ envName: "staging", profile: "production", retention: { mode: "COMPLIANCE", days: 1 } });
      await checkLockDrift(h.deps, START);
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ mode: "COMPLIANCE", days: 1, bucket: BUCKET });
    });

    it("can only be created: every write to the ratchet over many runs is a PutItem with attribute_not_exists, never an update or an unconditional put", async () => {
      const h = harness();
      const writes: Array<{ name: string; condition: unknown }> = [];
      h.hooks.before = (command) => {
        const input = command.input as { Item?: { pk?: string; sk?: string }; Key?: { pk?: string; sk?: string } };
        const target = input.Item ?? input.Key;
        if (target?.pk === "AUDIT_LOCK" && target.sk === "RATCHET" && command.constructor.name !== "GetCommand") writes.push({ name: command.constructor.name, condition: command.input.ConditionExpression });
      };
      appendRecords(h, A, 2);
      await run(h, at(0));
      h.clock.now = at(1);
      appendRecords(h, A, 2);
      await run(h, at(1));
      await run(h, at(2));
      expect(writes).toStrictEqual([{ name: "PutCommand", condition: "attribute_not_exists(pk)" }]);
      // The sweep's cursor lives under AUDIT_SWEEP, so the only thing the anchor ever writes under AUDIT_LOCK is that one create-only put.
      expect(h.operations.filter((operation) => operation.pk === "AUDIT_LOCK").map((operation) => operation.action).filter((action) => action !== "GetItem")).toStrictEqual(["PutItem"]);
    });

    it("treats any existing marker as ratcheted, whatever its mode field says (a corrupted or rewritten marker fails closed)", async () => {
      for (const marker of [{ mode: "GOVERNANCE" }, { mode: "" }, {}, { mode: 7 }, { mode: "COMPLIANCE", days: "x" }]) {
        const h = harness({ retention: { mode: "GOVERNANCE", days: 1 }, profile: "trial" });
        h.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", bucket: BUCKET, since: "2026-01-01T00:00:00.000Z", ...marker });
        h.logs.length = 0;
        const status = await checkLockDrift(h.deps, START);
        expect(status, JSON.stringify(marker)).toStrictEqual({ ok: false, floor: { mode: "COMPLIANCE", days: 365 }, ratcheted: true });
        expect(mismatches(h), JSON.stringify(marker)).toContainEqual(expect.objectContaining({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 } }));
        expect(await currentFloor(h.deps), JSON.stringify(marker)).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
      }
    });

    it("is not lowered by AUDIT_ENV_NAME: a staging, test or dev name after a production ratchet still requires COMPLIANCE for 365 days", async () => {
      for (const envName of ["staging", "test", "dev", "dev-eu"]) {
        const h = harness();
        await checkLockDrift(h.deps, START);
        // A template edit renames the environment and a governance or short compliance bucket goes with it.
        h.deps.lock = { ...h.deps.lock, envName, profile: "trial" };
        h.s3.setDefaultRetention("COMPLIANCE", 1);
        h.logs.length = 0;
        expect(await checkLockDrift(h.deps, at(1)), envName).toMatchObject({ ok: false, floor: { mode: "COMPLIANCE", days: 365 }, ratcheted: true });
        expect(mismatches(h), envName).toContainEqual(expect.objectContaining({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "COMPLIANCE", days: 1 } }));
        h.s3.setDefaultRetention("GOVERNANCE", 1);
        expect(await checkLockDrift(h.deps, at(2)), envName).toMatchObject({ ok: false });
        expect(await currentFloor(h.deps), envName).toStrictEqual({ mode: "COMPLIANCE", days: 365 });
      }
    });

    it("logs audit.lock_config_mismatch and blocks when the ratchet names another bucket than the configured one", async () => {
      const h = harness();
      h.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, bucket: "some-other-bucket", since: "2026-01-01T00:00:00.000Z" });
      const status = await checkLockDrift(h.deps, START);
      expect(status).toMatchObject({ ok: false, ratcheted: true });
      expect(mismatches(h)).toStrictEqual([expect.objectContaining({ level: "error", check: "ratchet_bucket", expected: BUCKET, actual: "some-other-bucket" })]);
      // The anchor does not finalize anything either.
      const blocked = harness();
      blocked.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, bucket: "some-other-bucket", since: "2026-01-01T00:00:00.000Z" });
      appendRecords(blocked, A, 3);
      expect(await run(blocked, at(0))).toMatchObject({ status: "stopped", reason: "lock_config_mismatch", epochs: [] });
      expect(blocked.s3.putCalls()).toHaveLength(0);
      expect(stateOf(blocked, A)).toBeUndefined();
      // A marker with no bucket name at all is the same (it fails closed).
      const nameless = harness();
      nameless.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, since: "2026-01-01T00:00:00.000Z" });
      expect(await checkLockDrift(nameless.deps, START)).toMatchObject({ ok: false });
      expect(mismatches(nameless)).toContainEqual(expect.objectContaining({ check: "ratchet_bucket", expected: BUCKET }));
    });

    it("keeps the floor at compliance when a later deploy says trial, and alarms on the governance bucket", async () => {
      const h = harness();
      await checkLockDrift(h.deps, START);
      // A raw CloudFormation update: profile trial, governance for one day, the function's values changed with it.
      h.s3.setDefaultRetention("GOVERNANCE", 1);
      h.deps.lock = { ...h.deps.lock, profile: "trial", deployed: { mode: "GOVERNANCE", days: 1 } };
      h.logs.length = 0;
      const status = await checkLockDrift(h.deps, at(1));
      expect(status).toStrictEqual({ ok: false, floor: { mode: "COMPLIANCE", days: 365 }, ratcheted: true });
      expect(mismatches(h)).toContainEqual(expect.objectContaining({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "GOVERNANCE", days: 1 } }));
    });

    it("is not set by a trial install, which can later become production (and is ratcheted then)", async () => {
      const h = harness({ retention: { mode: "GOVERNANCE", days: 1 }, profile: "trial" });
      await checkLockDrift(h.deps, START);
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toBeUndefined();
      h.s3.setDefaultRetention("COMPLIANCE", 1096);
      h.deps.lock = { ...h.deps.lock, profile: "production", deployed: { mode: "COMPLIANCE", days: 1096 } };
      expect(await checkLockDrift(h.deps, at(1))).toMatchObject({ ok: true, ratcheted: true });
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ mode: "COMPLIANCE" });
    });

    it("is written with a condition, so a second writer cannot move the since date, and reads strongly consistently", async () => {
      const h = harness();
      h.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, bucket: BUCKET, since: "2026-01-01T00:00:00.000Z" });
      await checkLockDrift(h.deps, START);
      expect(h.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ since: "2026-01-01T00:00:00.000Z" });
      // A marker written between the read and the write is the same ratchet.
      const raced = harness();
      raced.hooks.before = (command) => {
        if (command.constructor.name === "PutCommand" && (command.input.Item as { pk?: string }).pk === "AUDIT_LOCK") {
          raced.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, bucket: BUCKET, since: "2026-02-02T00:00:00.000Z" });
        }
      };
      expect(await checkLockDrift(raced.deps, START)).toMatchObject({ ok: true, ratcheted: true });
      expect(raced.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ since: "2026-02-02T00:00:00.000Z" });
    });

    it("holds a test name's days but not its governance once it has been seen in compliance", async () => {
      const h = harness({ envName: "staging", profile: "production", retention: { mode: "COMPLIANCE", days: 1 } });
      expect(await checkLockDrift(h.deps, START)).toMatchObject({ ok: true, floor: { mode: "COMPLIANCE", days: 1 }, ratcheted: true });
      h.s3.setDefaultRetention("GOVERNANCE", 1);
      h.deps.lock = { ...h.deps.lock, deployed: { mode: "GOVERNANCE", days: 1 } };
      expect(await checkLockDrift(h.deps, at(1))).toMatchObject({ ok: false });
    });
  });

  it("alarms, and does not block, when the bucket differs from the deployed mode and days but still meets the floor", async () => {
    const h = harness({ deployed: { mode: "COMPLIANCE", days: 1096 } });
    h.s3.setDefaultRetention("COMPLIANCE", 400);
    expect(await checkLockDrift(h.deps, START)).toMatchObject({ ok: true });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "default_retention_deployed", expected: { mode: "COMPLIANCE", days: 1096 }, actual: { mode: "COMPLIANCE", days: 400 } })]);
  });

  it("flags versioning that is suspended or off, and blocks", async () => {
    for (const versioning of ["Suspended", undefined] as const) {
      const h = harness();
      h.s3.versioning = versioning;
      expect(await checkLockDrift(h.deps, START), String(versioning)).toMatchObject({ ok: false });
      expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "versioning", expected: "Enabled", actual: versioning ?? "none" })]);
    }
  });

  it("flags an edited bucket policy with both hashes, and a missing one", async () => {
    const h = harness();
    h.s3.policy = bucketPolicyText("Backdoor");
    const status = await checkLockDrift(h.deps, START);
    // The policy hash alarms but does not stop sealing: a false positive (S3's serialization, a published template) must not stop the ledger.
    expect(status).toMatchObject({ ok: true });
    const expected = h.deps.lock.bucketPolicySha256;
    const actual = bucketPolicyHash(bucketPolicyText("Backdoor"), policyContext("acme"));
    expect(actual).not.toBe(expected);
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "bucket_policy", level: "error", expected, actual })]);

    const none = harness();
    none.s3.policy = undefined;
    expect(await checkLockDrift(none.deps, START)).toMatchObject({ ok: true });
    expect(mismatches(none)).toStrictEqual([expect.objectContaining({ check: "bucket_policy", expected, actual: "none" })]);
  });

  it("calls a bucket without an Object Lock configuration a mismatch", async () => {
    const h = harness();
    h.s3.before = (call) => {
      if (call.command === "GetObjectLockConfiguration") throw Object.assign(new Error("none"), { name: "ObjectLockConfigurationNotFoundError", $metadata: { httpStatusCode: 404 } });
    };
    expect(await checkLockDrift(h.deps, START)).toMatchObject({ ok: false });
    expect(mismatches(h)[0]).toMatchObject({ check: "default_retention_floor", actual: "none" });
  });

  it("lets any other S3 error out, so a check that could not be made is never read as a pass", async () => {
    const h = harness();
    h.s3.before = (call) => {
      if (call.command === "GetBucketPolicy") throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    };
    await expect(checkLockDrift(h.deps, START)).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("makes exactly the three configuration reads", async () => {
    const h = harness();
    await checkLockDrift(h.deps, START);
    expect(h.s3.calls.map((call) => call.command).sort()).toStrictEqual(["GetBucketPolicy", "GetBucketVersioning", "GetObjectLockConfiguration"]);
  });
});

describe("enforceObjectLock", () => {
  /** Seals one org and returns the objects the anchor recorded. */
  async function sealed(h: Harness) {
    appendRecords(h, A, 3);
    await run(h, at(0));
    const objects = intentOf(h, E0, A)!.objects as { records: Parameters<typeof enforceObjectLock>[1][number]; seal: Parameters<typeof enforceObjectLock>[1][number] };
    return objects;
  }

  it("passes objects that carry the floor, reading each by its version id, and logs nothing", async () => {
    const h = harness();
    const { records, seal } = await sealed(h);
    h.s3.calls.length = 0;
    h.logs.length = 0;
    expect(await enforceObjectLock(h.deps, [records, seal], at(0))).toStrictEqual({ ok: true, failed: [] });
    expect(h.logs).toStrictEqual([]);
    const heads = h.s3.calls.filter((call) => call.command === "HeadObject");
    expect(heads.map((call) => [call.key, call.input.VersionId])).toStrictEqual([[records.key, records.versionId], [seal.key, seal.versionId]]);
  });

  it("refuses an object that comes back governance in production, names it, and returns it as failed", async () => {
    const h = harness();
    const { records, seal } = await sealed(h);
    h.s3.setObjectLock(seal.key, seal.versionId, { mode: "GOVERNANCE" });
    h.logs.length = 0;
    const result = await enforceObjectLock(h.deps, [records, seal], at(0));
    expect(result).toStrictEqual({ ok: false, failed: [seal] });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({
      level: "error", check: "object", key: seal.key, versionId: seal.versionId, expected: { mode: "COMPLIANCE", days: 365 }, actual: like({ mode: "GOVERNANCE" }),
    })]);
  });

  it("refuses a retain-until date shorter than the floor allows (one day of slack), and accepts exactly that", async () => {
    const h = harness();
    const { seal } = await sealed(h);
    const lockedAt = h.s3.versionsOf(seal.key)[0]!.lastModified;
    h.s3.setObjectLock(seal.key, seal.versionId, { retainUntil: lockedAt + 364 * DAY - 1 });
    expect(await enforceObjectLock(h.deps, [seal], at(0))).toMatchObject({ ok: false });
    expect(mismatches(h)[0]).toMatchObject({ check: "object", actual: like({ mode: "COMPLIANCE", retainUntil: new Date(lockedAt + 364 * DAY - 1).toISOString() }) });
    h.logs.length = 0;
    h.s3.setObjectLock(seal.key, seal.versionId, { retainUntil: lockedAt + 364 * DAY });
    expect(await enforceObjectLock(h.deps, [seal], at(0))).toMatchObject({ ok: true });
    expect(h.logs).toStrictEqual([]);
  });

  it("measures the retention from when the object was locked, so an epoch that was stalled for days can still be finished", async () => {
    const h = harness();
    const { seal } = await sealed(h);
    h.logs.length = 0;
    expect(await enforceObjectLock(h.deps, [seal], at(0) + 30 * DAY)).toMatchObject({ ok: true });
    // An object locked for exactly the floor's 365 days, checked 30 days later, is still the lock it was given.
    const lockedAt = h.s3.versionsOf(seal.key)[0]!.lastModified;
    h.s3.setObjectLock(seal.key, seal.versionId, { retainUntil: lockedAt + 365 * DAY });
    expect(await enforceObjectLock(h.deps, [seal], lockedAt + 30 * DAY)).toMatchObject({ ok: true });
    expect(h.logs).toStrictEqual([]);
  });

  it("accepts compliance where governance is the floor, and refuses governance where compliance is", async () => {
    const trial = harness({ retention: { mode: "COMPLIANCE", days: 1096 }, envName: "staging", profile: "trial" });
    const { seal } = await sealed(trial);
    expect(await enforceObjectLock(trial.deps, [seal], at(0))).toMatchObject({ ok: true });
  });

  it("applies the ratchet: a governance object is refused in a trial profile once the install has been in compliance", async () => {
    const h = harness();
    const { seal } = await sealed(h);
    await checkLockDrift(h.deps, at(0));
    h.deps.lock = { ...h.deps.lock, profile: "trial" };
    h.s3.setObjectLock(seal.key, seal.versionId, { mode: "GOVERNANCE", retainUntil: at(0) + DAY });
    expect(await currentFloor(h.deps)).toStrictEqual({ mode: "COMPLIANCE", days: 365 } satisfies LockFloor);
    expect(await enforceObjectLock(h.deps, [seal], at(0))).toMatchObject({ ok: false });
  });

  describe("an object is judged by the profile in force when it was written (a trial install that became production)", () => {
    const ratchetAt = (h: Harness, sinceMs: number) => h.db.set({ pk: "AUDIT_LOCK", sk: "RATCHET", mode: "COMPLIANCE", days: 365, bucket: BUCKET, since: new Date(sinceMs).toISOString() });

    it("holds an object written before the ratchet to the trial floor it was written under, and one written after it to the ratchet", async () => {
      const h = harness({ envName: "acme", profile: "trial", retention: { mode: "GOVERNANCE", days: 1 } });
      const { records, seal } = await sealed(h);
      // The stack is updated to production: the bucket is compliance from now on, the ratchet is set by the next run.
      h.s3.setDefaultRetention("COMPLIANCE", 1096);
      h.deps.lock = { ...h.deps.lock, profile: "production", deployed: { mode: "COMPLIANCE", days: 1096 } };
      expect(await checkLockDrift(h.deps, at(1))).toMatchObject({ ok: true, ratcheted: true });
      expect(await enforceObjectLock(h.deps, [records, seal], at(1))).toStrictEqual({ ok: true, failed: [] });
      // An object that is written under the ratchet carries the ratchet's floor.
      h.clock.now = at(2);
      h.s3.forceVersion("late-key", "late");
      const lateVersion = h.s3.versionsOf("late-key")[0]!;
      h.s3.setObjectLock("late-key", lateVersion.versionId, { mode: "GOVERNANCE", retainUntil: at(2) + DAY });
      const lateObject = { key: "late-key", versionId: lateVersion.versionId, lastModified: new Date(at(2)).toISOString(), lockMode: "GOVERNANCE" as const, retainUntil: new Date(at(2) + DAY).toISOString() };
      expect(await enforceObjectLock(h.deps, [lateObject], at(2))).toMatchObject({ ok: false });
    });

    it("still refuses an old object that has no lock at all", async () => {
      const h = harness({ envName: "acme", profile: "trial", retention: { mode: "GOVERNANCE", days: 1 } });
      const { seal } = await sealed(h);
      ratchetAt(h, at(1));
      h.s3.setObjectLock(seal.key, seal.versionId, { retainUntil: at(0) - DAY });
      expect(await enforceObjectLock(h.deps, [seal], at(1))).toMatchObject({ ok: false });
    });

    it("uses a margin around the ratchet's time: an object written within seconds of it (S3 truncates to the second) gets the ratchet's floor", async () => {
      const h = harness({ envName: "acme", profile: "trial", retention: { mode: "GOVERNANCE", days: 1 } });
      const { seal } = await sealed(h);
      const writtenAt = h.s3.versionsOf(seal.key)[0]!.lastModified;
      ratchetAt(h, writtenAt + 1000);
      expect(await enforceObjectLock(h.deps, [seal], at(1))).toMatchObject({ ok: false });
      ratchetAt(h, writtenAt);
      expect(await enforceObjectLock(h.deps, [seal], at(1))).toMatchObject({ ok: false });
      ratchetAt(h, writtenAt + 60_000);
      expect(await enforceObjectLock(h.deps, [seal], at(1))).toMatchObject({ ok: true });
    });
  });

  it("calls an object that is gone a mismatch, and lets any other error out", async () => {
    const h = harness();
    const { records, seal } = await sealed(h);
    const gone = { ...seal, versionId: "no-such-version" };
    h.logs.length = 0;
    expect(await enforceObjectLock(h.deps, [records, gone], at(0))).toStrictEqual({ ok: false, failed: [gone] });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "object", key: seal.key, versionId: "no-such-version", actual: "missing" })]);
    h.s3.before = (call) => {
      if (call.command === "HeadObject") throw Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    };
    await expect(enforceObjectLock(h.deps, [seal], at(0))).rejects.toMatchObject({ name: "SlowDown" });
  });

  it("adds the context the caller gives to each log entry", async () => {
    const h = harness();
    const { seal } = await sealed(h);
    h.s3.setObjectLock(seal.key, seal.versionId, { mode: "GOVERNANCE" });
    h.logs.length = 0;
    await enforceObjectLock(h.deps, [seal], at(0), { context: { orgId: A, epochId: E0 } });
    expect(mismatches(h)[0]).toMatchObject({ orgId: A, epochId: E0 });
  });
});

describe("the anchor does not finalize when the lock is wrong", () => {
  it("a production-named anchor whose deploy env says GOVERNANCE/30 still requires COMPLIANCE/365: it stops before writing anything", async () => {
    const h = harness({ retention: { mode: "GOVERNANCE", days: 30 }, profile: "production", deployed: { mode: "GOVERNANCE", days: 30 } });
    appendRecords(h, A, 3);
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "stopped", reason: "lock_config_mismatch", epochs: [] });
    expect(mismatches(h)).toContainEqual(expect.objectContaining({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "GOVERNANCE", days: 30 } }));
    expect(eventsOf(h, "audit.epoch_stopped")).toStrictEqual([expect.objectContaining({ reason: "lock_config_mismatch" })]);
    expect(h.s3.putCalls()).toHaveLength(0);
    expect(stateOf(h, A)).toBeUndefined();
    expect(h.db.find((item) => item.sk === "META")).toHaveLength(0);
    expect(h.db.get("AUDIT_DIRTY", A)).toBeDefined();
  });

  it("an object that comes back governance in production is not finalized and is alarmed; the other org is finalized and the epoch closes", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    appendRecords(h, B, 2);
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 1)) {
        const version = h.s3.versionsOf(sealObjectKey(A, 1))[0]!;
        h.s3.setObjectLock(call.key, version.versionId, { mode: "GOVERNANCE" });
      }
    };
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "sealed", epochs: [expect.objectContaining({ orgs: 2, blocked: 1 })] });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "object", key: sealObjectKey(A, 1), orgId: A, epochId: E0 })]);
    // A: seal is in the statement, but not finalized: no state, no index item, marker kept, intent blocked.
    expect(stateOf(h, A)).toBeUndefined();
    expect(h.db.get(`SEALS#${A}`, "000000000001")).toBeUndefined();
    expect(h.db.get("AUDIT_DIRTY", A)).toBeDefined();
    expect(intentOf(h, E0, A)).toMatchObject({ finalized: false, blocked: "lock_config_mismatch" });
    // B: finalized.
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 2 });
    expect(metaOf(h, E0)).toMatchObject({ status: "sealed" });
  });

  it("a records object with a short retain-until date is refused the same way", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === recordsObjectKey(A, 1)) {
        const version = h.s3.versionsOf(call.key)[0]!;
        h.s3.setObjectLock(call.key, version.versionId, { retainUntil: version.lastModified + 30 * DAY });
      }
    };
    await run(h, at(0));
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ key: recordsObjectKey(A, 1), orgId: A })]);
    expect(stateOf(h, A)).toBeUndefined();
  });

  it("a statement or leaves object with a weak lock stops the run before any org is finalized, and the next run finishes the epoch once it is right", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    appendRecords(h, B, 2);
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E0)) {
        h.s3.setObjectLock(call.key, h.s3.versionsOf(call.key)[0]!.versionId, { mode: "GOVERNANCE" });
      }
    };
    const stopped = await run(h, at(0));
    expect(stopped).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "object", key: statementObjectKey(E0), epochId: E0 })]);
    expect(stateOf(h, A)).toBeUndefined();
    expect(stateOf(h, B)).toBeUndefined();
    expect(metaOf(h, E0)).toMatchObject({ status: "frozen" });
    expect(epochHead(h)).toMatchObject({ openEpochId: E0 });
    expect(intentOf(h, E0, A)).toMatchObject({ finalized: false });

    // It stays stopped until the object is right (here: the test restores it; a person cannot, which is the runbook's escalation).
    h.s3.after = undefined;
    h.logs.length = 0;
    expect(await run(h, at(1))).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    h.s3.setObjectLock(statementObjectKey(E0), h.s3.versionsOf(statementObjectKey(E0))[0]!.versionId, { mode: "COMPLIANCE" });
    h.logs.length = 0;
    expect(await run(h, at(2))).toMatchObject({ status: "sealed", epochs: [expect.objectContaining({ epochId: E0, resumed: true, orgs: 2 })] });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 2 });
    expect(lockLogs(h)).toStrictEqual([]);
  });

  it("a trial install (profile trial) under a production-kind name seals in governance without any alarm", async () => {
    const h = harness({ envName: "acme", profile: "trial", retention: { mode: "GOVERNANCE", days: 1 } });
    appendRecords(h, A, 3);
    expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
    expect(lockLogs(h)).toStrictEqual([]);
    expect(h.db.get("AUDIT_LOCK", "RATCHET")).toBeUndefined();
  });

  it("production profile: the ratchet is written, and a later deploy that says trial still requires compliance and refuses to finalize", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
    expect(h.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ mode: "COMPLIANCE" });

    h.s3.setDefaultRetention("GOVERNANCE", 1);
    h.deps.lock = { ...h.deps.lock, profile: "trial", deployed: { mode: "GOVERNANCE", days: 1 } };
    h.clock.now = at(1);
    appendRecords(h, A, 2);
    h.logs.length = 0;
    const result = await run(h, at(1));
    expect(result).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(mismatches(h)).toContainEqual(expect.objectContaining({ check: "default_retention_floor", expected: { mode: "COMPLIANCE", days: 365 }, actual: { mode: "GOVERNANCE", days: 1 } }));
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
    expect(h.s3.putCalls().filter((call) => (call.key ?? "").includes(E1))).toHaveLength(0);
  });

  it("a trial install upgraded to production while an epoch is open finishes that epoch (its objects keep their trial floor), then seals under compliance", async () => {
    const h = harness({ envName: "acme", profile: "trial", retention: { mode: "GOVERNANCE", days: 1 } });
    appendRecords(h, A, 3);
    appendRecords(h, B, 2);
    // The run dies before any org is finalized: the epoch stays open with GOVERNANCE/1 objects.
    h.hooks.before = (command) => {
      if (command.constructor.name !== "TransactWriteCommand") return;
      const items = command.input.TransactItems as Array<Record<string, { Item?: { pk?: string } }>>;
      if (items.some((entry) => entry.Put?.Item?.pk?.startsWith("SEALED#") === true)) throw Object.assign(new Error("the process died"), { name: "ProcessDied" });
    };
    await expect(run(h, at(0))).rejects.toThrow("the process died");
    h.hooks.before = undefined;
    expect(epochHead(h)).toMatchObject({ openEpochId: E0 });
    expect(h.db.get("AUDIT_LOCK", "RATCHET")).toBeUndefined();

    // The stack is updated to production: compliance bucket, the production profile.
    h.s3.setDefaultRetention("COMPLIANCE", 1096);
    h.deps.lock = { ...h.deps.lock, profile: "production", deployed: { mode: "COMPLIANCE", days: 1096 } };
    h.clock.now = at(1);
    h.logs.length = 0;
    expect(await run(h, at(1))).toMatchObject({ status: "sealed", epochs: [expect.objectContaining({ epochId: E0, resumed: true, orgs: 2, blocked: 0 })] });
    expect(h.db.get("AUDIT_LOCK", "RATCHET")).toMatchObject({ mode: "COMPLIANCE", days: 365, bucket: BUCKET });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 2 });
    expect(lockLogs(h)).toStrictEqual([]);

    // The objects written from now on carry the ratchet's floor: a governance seal is refused.
    h.clock.now = at(2);
    appendRecords(h, A, 2);
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 4)) h.s3.setObjectLock(call.key, h.s3.versionsOf(call.key)[0]!.versionId, { mode: "GOVERNANCE" });
    };
    await run(h, at(2));
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "object", key: sealObjectKey(A, 4), orgId: A })]);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
  });

  it("a bucket whose versioning was suspended blocks the run", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.s3.versioning = "Suspended";
    expect(await run(h, at(0))).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "versioning" })]);
    expect(h.s3.putCalls()).toHaveLength(0);
  });

  it("an edited bucket policy is alarmed on every run but does not stop sealing", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.s3.policy = bucketPolicyText("Backdoor");
    expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
    expect(mismatches(h)).toStrictEqual([expect.objectContaining({ check: "bucket_policy" })]);
    appendRecords(h, A, 1);
    await run(h, at(1));
    expect(mismatches(h)).toHaveLength(2);
  });

  it("a clean bucket logs no lock or version event across several epochs", async () => {
    const h = harness();
    for (const org of [A, B, C]) appendRecords(h, org, 3);
    await run(h, at(0));
    for (let epoch = 1; epoch < 4; epoch += 1) {
      h.clock.now = at(epoch);
      appendRecords(h, A, 2);
      await run(h, at(epoch));
    }
    expect(lockLogs(h)).toStrictEqual([]);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 9 });
  });
});

describe("sweepSealedVersions", () => {
  /** Three orgs sealed over two epochs: six SEALS# index items and twelve sealed keys. */
  async function sealedBucket(options: { sweepKeysPerRun?: number } = {}) {
    const h = harness(options);
    for (const org of [A, B, C]) appendRecords(h, org, 2);
    await run(h, at(0));
    h.clock.now = at(1);
    for (const org of [A, B, C]) appendRecords(h, org, 2);
    await run(h, at(1));
    h.logs.length = 0;
    return h;
  }
  const keysOf = (org: string) => [recordsObjectKey(org, 1), sealObjectKey(org, 1), recordsObjectKey(org, 3), sealObjectKey(org, 3)];

  it("is 200 keys a run by default", () => {
    expect(AUDIT_VERSION_SWEEP_KEYS_PER_RUN).toBe(200);
  });

  it("logs nothing for a clean bucket and covers every sealed key in one pass", async () => {
    const h = await sealedBucket();
    h.s3.calls.length = 0;
    const result = await sweepSealedVersions(h.deps, undefined);
    expect(result).toStrictEqual({ checked: 12, drift: 0, next: undefined });
    expect(h.logs).toStrictEqual([]);
    expect(new Set(h.s3.calls.filter((call) => call.command === "ListObjectVersions").map((call) => call.input.Prefix))).toStrictEqual(new Set([A, B, C].flatMap(keysOf)));
  });

  it("logs audit.version_drift for a delete marker on a sealed key", async () => {
    const h = await sealedBucket();
    h.s3.addDeleteMarker(sealObjectKey(B, 1));
    const result = await sweepSealedVersions(h.deps, undefined);
    expect(result).toMatchObject({ checked: 12, drift: 1 });
    expect(drifts(h)).toStrictEqual([expect.objectContaining({ level: "error", orgId: B, key: sealObjectKey(B, 1), reason: "delete_marker" })]);
  });

  it("logs audit.version_drift for a second version on a sealed key, whatever its bytes", async () => {
    const h = await sealedBucket();
    h.s3.forceVersion(recordsObjectKey(C, 3), "something else");
    await sweepSealedVersions(h.deps, undefined);
    expect(drifts(h)).toStrictEqual([expect.objectContaining({ orgId: C, key: recordsObjectKey(C, 3), reason: "extra_version" })]);
  });

  it("logs when the one version is not the one recorded, or when no version is left", async () => {
    const h = await sealedBucket();
    const replaced = sealObjectKey(A, 3);
    h.s3.entries.set(replaced, []);
    h.s3.forceVersion(replaced, "replaced");
    h.s3.entries.set(recordsObjectKey(A, 3), []);
    await sweepSealedVersions(h.deps, undefined);
    expect(drifts(h).map((entry) => [entry.key, entry.reason]).sort()).toStrictEqual([
      [recordsObjectKey(A, 3), "version_missing"], [replaced, "version_replaced"],
    ].sort());
  });

  it("ignores keys that merely start with a sealed key", async () => {
    const h = await sealedBucket();
    h.s3.forceVersion(`${sealObjectKey(A, 1)}.bak`, "x");
    await sweepSealedVersions(h.deps, undefined);
    expect(drifts(h)).toStrictEqual([]);
  });

  it("takes at most the budget of keys a run and cycles through all of them, then starts over", async () => {
    const h = await sealedBucket({ sweepKeysPerRun: 4 });
    // Plant one problem on every org's last seal so each pass finds all three.
    for (const org of [A, B, C]) h.s3.addDeleteMarker(sealObjectKey(org, 3));
    let cursor: Awaited<ReturnType<typeof sweepSealedVersions>>["next"];
    const seen: string[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const result = await sweepSealedVersions(h.deps, cursor);
      expect(result.checked, `pass ${String(pass)}`).toBeLessThanOrEqual(4);
      cursor = result.next;
      if (cursor === undefined) break;
    }
    for (const entry of drifts(h)) seen.push(String(entry.key));
    expect(new Set(seen)).toStrictEqual(new Set([A, B, C].map((org) => sealObjectKey(org, 3))));
    expect(cursor).toBeUndefined();
    // Every pass listed only keys within its budget.
    const listed = h.s3.calls.filter((call) => call.command === "ListObjectVersions").length;
    expect(listed).toBeGreaterThanOrEqual(12);
  });

  it("each run of the anchor sweeps the next slice and remembers where it stopped", async () => {
    const h = harness({ sweepKeysPerRun: 4 });
    for (const org of [A, B, C]) appendRecords(h, org, 2);
    await run(h, at(0));
    h.clock.now = at(1);
    for (const org of [A, B, C]) appendRecords(h, org, 2);
    await run(h, at(1));
    // Twelve sealed keys, four a run: after three more runs every key has been looked at once.
    for (const org of [A, B, C]) h.s3.addDeleteMarker(sealObjectKey(org, 1));
    h.logs.length = 0;
    for (let epoch = 2; epoch < 8; epoch += 1) {
      h.clock.now = at(epoch);
      await run(h, at(epoch));
    }
    const found = new Set(drifts(h).map((entry) => entry.key));
    expect(found).toStrictEqual(new Set([A, B, C].map((org) => sealObjectKey(org, 1))));
    expect(h.db.get("AUDIT_SWEEP", "CURSOR")).toBeDefined();
  });

  it("a sweep that fails (a throttled ListObjectVersions, an unreadable cursor) is logged and alarmed but does not fail the run, which seals as usual", async () => {
    const throttled = Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    const h = harness();
    appendRecords(h, A, 2);
    await run(h, at(0));
    h.clock.now = at(1);
    appendRecords(h, A, 2);
    appendRecords(h, B, 2);
    h.logs.length = 0;
    h.s3.before = (call) => {
      // Only the sweep's listing (it passes MaxKeys); the anchor's own look before a write must still work.
      if (call.command === "ListObjectVersions" && call.input.MaxKeys !== undefined) throw throttled;
    };
    const result = await run(h, at(1));
    expect(result).toMatchObject({ status: "sealed" });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 4 });
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 2 });
    expect(eventsOf(h, "audit.lock_sweep_failed")).toStrictEqual([expect.objectContaining({ level: "error", error: "SlowDown" })]);
    expect(AUDIT_LOCK_DRIFT_EVENTS).toContain("audit.lock_sweep_failed");
    // The configuration checks stay fatal: a failing read of the bucket's settings still stops the run.
    h.s3.before = (call) => {
      if (call.command === "GetBucketVersioning") throw throttled;
    };
    h.clock.now = at(2);
    appendRecords(h, A, 1);
    await expect(run(h, at(2))).rejects.toThrow("slow down");
  });

  it("alerts on drift in a run that goes on to seal, and does not touch the sealed state", async () => {
    const h = await sealedBucket();
    h.s3.addDeleteMarker(sealObjectKey(A, 1));
    h.clock.now = at(2);
    appendRecords(h, B, 1);
    const result = await run(h, at(2));
    expect(result).toMatchObject({ status: "sealed" });
    expect(drifts(h).map((entry) => entry.key)).toContain(sealObjectKey(A, 1));
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 5 });
  });
});

describe("sealed objects are read by their recorded version id", () => {
  it("continuity reads the locked seal by version id, so a newer version at the key changes nothing it reads", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    await run(h, at(0));
    const recorded = stateOf(h, A)!.lastSealVersionId as string;
    // A newer version appears at the seal key (somebody's rewrite). The continuity check must still read the recorded one.
    h.s3.forceVersion(sealObjectKey(A, 1), "{\"not\":\"the seal\"}");
    h.clock.now = at(1);
    appendRecords(h, A, 2);
    h.s3.calls.length = 0;
    expect(await run(h, at(1))).toMatchObject({ status: "sealed", epochs: [expect.objectContaining({ orgs: 1 })] });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 5 });
    const reads = h.s3.calls.filter((call) => call.command === "GetObject" && call.key === sealObjectKey(A, 1));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.input.VersionId, "every read of a sealed key carries its version id").toBe(recorded);
    // And the sweep reports the extra version.
    expect(drifts(h).map((entry) => entry.key)).toContain(sealObjectKey(A, 1));
  });

  it("the anchor never reads a sealed key without a version id, except the 412 look at a key it just failed to create", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    await run(h, at(0));
    h.clock.now = at(1);
    appendRecords(h, A, 2);
    h.s3.calls.length = 0;
    await run(h, at(1));
    const bare = h.s3.calls.filter((call) => (call.command === "GetObject" || call.command === "HeadObject") && call.input.VersionId === undefined);
    expect(bare).toStrictEqual([]);
  });
});

