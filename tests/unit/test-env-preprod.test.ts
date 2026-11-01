// Proof and test environment E9: pre-prod access (a narrow STS session), the probe, and the mode used per service.
import { describe, expect, it } from "vitest";
import { EvidenceEnvironmentSchema, TestEnvironmentBodySchema, type TestEnvironmentBody } from "@agentx/contracts";
import {
  PREPROD_SESSION_SECONDS, PreprodAccessError, evidenceServices, openPreprodSession, preprodExternalId, preprodSessionPolicy, preprodUnreachableNextStep, probePreprod, probeRequestOf, resolveRoundModes, type AssumedCredentials, type PreprodAws,
} from "../../packages/broker/src/test-env/preprod.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const sha = (letter: string) => letter.repeat(64);
const ARN = "arn:aws:sagemaker:us-west-2:222233334444:endpoint/partner-scorer";
const ROLE = "arn:aws:iam::222233334444:role/rovara-invoke";
const NOW = 1_800_000_000_000;
const service = (over: Record<string, unknown> = {}, preprod: Record<string, unknown> = {}) => ({ name: "scorer", kind: "sagemaker_runtime" as const, match: { endpointName: "partner-scorer" }, mode: "preprod" as const, preprod: { endpointArn: ARN, roleArn: ROLE, region: "us-west-2", ...preprod }, ...over });
const body = (services: unknown[], prodDeny: { accountIds: string[]; hosts: string[]; arnPrefixes: string[] } = { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] }): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [] }], roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services, data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny, capture: { screenshots: "failed", video: false, traces: false },
});
const svc = (over: Record<string, unknown> = {}, preprod: Record<string, unknown> = {}, prodDeny?: { accountIds: string[]; hosts: string[]; arnPrefixes: string[] }) => body([service(over, preprod)], prodDeny).services[0]!;
const creds = (over: Partial<AssumedCredentials> = {}): AssumedCredentials => ({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "s3cr3t-example", sessionToken: "token-example", expiration: new Date(NOW + 3_600_000), ...over });
function aws(over: Partial<PreprodAws> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const port: PreprodAws = { ownAccountId: "999988887777", assumeRole: (input) => { calls.push({ ...input }); return Promise.resolve(creds()); }, ...over };
  return { port, calls };
}
const open = (port: PreprodAws, over: { service?: ReturnType<typeof svc>; taskId?: string; prodDeny?: TestEnvironmentBody["prodDeny"] | undefined } = {}) =>
  openPreprodSession(port, { orgId: ORG, taskId: "task-1234abcd-9", service: over.service ?? svc(), prodDeny: over.prodDeny ?? { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] }, now: () => NOW });

describe("the session", () => {
  it("assumes the customer's role for an hour, with a policy that invokes this one endpoint only, an org external id and a task session name", async () => {
    const { port, calls } = aws();
    const { credentials, expiresAtMs } = await open(port);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ SourceIdentity: "rovara-task1234abcd9", RoleArn: ROLE, DurationSeconds: 3_600, RoleSessionName: "rovara-task1234", ExternalId: preprodExternalId(ORG) });
    expect(JSON.parse(calls[0]!["Policy"] as string)).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sagemaker:InvokeEndpoint"], Resource: ARN }] });
    expect(PREPROD_SESSION_SECONDS).toBe(3_600);
    expect(credentials.accessKeyId).toBe("ASIAEXAMPLE");
    expect(expiresAtMs).toBe(NOW + 3_600_000);
  });
  it("the external id is the org's own and differs between orgs", () => {
    expect(preprodExternalId(ORG)).toMatch(/^rovara-testenv-[0-9a-f]{32}$/u);
    expect(preprodExternalId(ORG)).not.toBe(preprodExternalId("org_bbbbbbbbbbbbbbbbbbbb"));
  });
  it("refuses before any AWS call: Rovara's own account, production, a mismatched endpoint, no role, another kind of service", async () => {
    const cases: Array<[string, ReturnType<typeof svc>, PreprodAws | undefined]> = [
      ["own_account", svc({}, { roleArn: "arn:aws:iam::999988887777:role/x" }), undefined],
      ["own_account", svc(), aws({ ownAccountId: undefined }).port],
      ["production", svc({}, { roleArn: "arn:aws:iam::111122223333:role/x", endpointArn: ARN }, { accountIds: [], hosts: [], arnPrefixes: [] }), undefined],
      ["arn_mismatch", svc({}, { endpointArn: "arn:aws:sagemaker:us-east-1:222233334444:endpoint/partner-scorer" }), undefined],
      ["arn_mismatch", svc({}, { endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/other" }), undefined],
      ["no_role", svc({}, { roleArn: undefined }), undefined],
      ["unsupported_kind", { ...svc({}, { endpointArn: undefined, url: "https://api.example.com/x" }), kind: "http" } as unknown as ReturnType<typeof svc>, undefined],
    ];
    for (const [code, service, port] of cases) {
      const fake = aws();
      const error = await open(port ?? fake.port, { service, prodDeny: code === "production" ? { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] } : undefined }).catch((caught: unknown) => caught);
      expect(error, code).toBeInstanceOf(PreprodAccessError);
      expect((error as PreprodAccessError).code, code).toBe(code);
      expect(fake.calls, code).toHaveLength(0);
    }
  });
  it("answers AWS's refusal and an outage in fixed words that hold no ARN, message or credential", async () => {
    const denied = await open(aws({ assumeRole: () => Promise.reject(Object.assign(new Error(`not authorized for ${ROLE}`), { name: "AccessDenied" })) }).port).then(() => { throw new Error("expected a refusal"); }, (caught: unknown) => caught as PreprodAccessError);
    expect(denied.code).toBe("refused");
    expect(denied.retryable).toBe(false);
    expect(denied.message).not.toContain("222233334444");
    const outage = await open(aws({ assumeRole: () => Promise.reject(new Error("socket hang up")) }).port).then(() => { throw new Error("expected a refusal"); }, (caught: unknown) => caught as PreprodAccessError);
    expect(outage).toMatchObject({ code: "unreachable", retryable: true });
  });
  it("does not use a session that is empty, already over, or longer than asked", async () => {
    for (const bad of [creds({ sessionToken: "" }), creds({ expiration: new Date(NOW - 1) }), creds({ expiration: new Date(NOW + 12 * 3_600_000) }), creds({ expiration: new Date("nope") }), {} as AssumedCredentials]) {
      const error = await open(aws({ assumeRole: () => Promise.resolve(bad) }).port).then(() => { throw new Error("expected a refusal"); }, (caught: unknown) => caught as PreprodAccessError);
      expect(error.code).toBe("bad_session");
    }
  });
  it("the policy stays within STS's size limit", () => {
    expect(() => preprodSessionPolicy(`arn:aws:sagemaker:us-west-2:222233334444:endpoint/${"a".repeat(3_000)}`)).toThrow(PreprodAccessError);
  });
});

describe("the probe", () => {
  it("is ok for a 2xx answer and fails with a fixed reason for an error status, a throw, or a hang", async () => {
    expect(await probePreprod(() => Promise.resolve({ status: 200 }))).toEqual({ ok: true });
    expect(await probePreprod(() => Promise.resolve({ status: 503 }))).toEqual({ ok: false, reason: "error_status" });
    expect(await probePreprod(() => Promise.reject(new Error("ECONNREFUSED 10.0.0.1")))).toEqual({ ok: false, reason: "unreachable" });
    expect(await probePreprod((signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), 20)).toEqual({ ok: false, reason: "timeout" });
  });
  it("uses the first recorded request as its canned payload, and has none without a recording", () => {
    expect(probeRequestOf({ entries: [{ requestHash: sha("a"), request: { contentType: "application/json", body: '{"partner":"p1"}' }, response: { status: 200, contentType: "application/json", body: "{}", latencyMs: 0 } }] })).toEqual({ contentType: "application/json", body: '{"partner":"p1"}' });
    expect(probeRequestOf({ entries: [] })).toBeUndefined();
  });
});

describe("modes", () => {
  const mock = { mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } };
  const services = body([
    { ...service({ name: "a-preprod" }) },
    { name: "b-auto", kind: "sagemaker_runtime", match: { endpointName: "b" }, mode: "auto", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/b", roleArn: ROLE, region: "us-west-2" }, ...mock },
    { name: "c-mock", kind: "sagemaker_runtime", match: { endpointName: "c" }, mode: "mock", ...mock },
  ]).services;
  it("preprod uses pre-prod, auto follows its probe, mock never looks", () => {
    const ok = resolveRoundModes(services, new Map([["a-preprod", { ok: true as const }], ["b-auto", { ok: true as const }]]));
    expect(ok).toEqual({ ok: true, modes: [{ name: "a-preprod", mode: "preprod", reason: "configured_preprod" }, { name: "b-auto", mode: "preprod", reason: "probe_ok" }, { name: "c-mock", mode: "mocked", reason: "configured_mock" }] });
    const fallback = resolveRoundModes(services, new Map([["a-preprod", { ok: true as const }], ["b-auto", { ok: false as const, reason: "timeout" as const }]]));
    expect(fallback).toMatchObject({ ok: true, modes: [{}, { name: "b-auto", mode: "mocked", reason: "probe_failed_fell_back" }, {}] });
  });
  it("a preprod service that cannot be reached fails the round, and a service with no probe counts as unreachable", () => {
    expect(resolveRoundModes(services, new Map([["a-preprod", { ok: false as const, reason: "unreachable" as const }]]))).toEqual({ ok: false, code: "preprod_unreachable", service: "a-preprod" });
    expect(resolveRoundModes(services, new Map())).toEqual({ ok: false, code: "preprod_unreachable", service: "a-preprod" });
    const auto = resolveRoundModes(services.slice(1), new Map());
    expect(auto).toMatchObject({ ok: true, modes: [{ mode: "mocked", reason: "probe_failed_fell_back" }, { mode: "mocked" }] });
  });
  it("retries a failed round once, then asks a person", () => {
    expect([preprodUnreachableNextStep(0), preprodUnreachableNextStep(1), preprodUnreachableNextStep(5)]).toEqual(["retry", "ask_card", "ask_card"]);
  });
  it("the evidence shows the mode USED, the fixture revision of a mocked service only, and the unrecorded answers it gave", () => {
    const decisions = [{ name: "a-preprod", mode: "preprod" as const, reason: "configured_preprod" as const }, { name: "b-auto", mode: "mocked" as const, reason: "probe_failed_fell_back" as const }];
    const entries = evidenceServices(decisions, new Map([["a-preprod", { revision: 9, recordedAt: "2026-10-01T00:00:00.000Z" }], ["b-auto", { revision: 2, recordedAt: "2026-11-02T00:00:00.000Z" }]]), new Map([["b-auto", 3], ["a-preprod", 4]]));
    expect(entries).toEqual([{ name: "a-preprod", mode: "preprod" }, { name: "b-auto", mode: "mocked", fixtureRevision: 2, recordedAt: "2026-11-02T00:00:00.000Z", unrecordedAnswered: 3 }]);
    expect(EvidenceEnvironmentSchema.safeParse({ tier: "sandbox", envRevision: 1, services: entries, data: "synthetic", accounts: [] }).success).toBe(true);
  });
  it("lists the task's new mock answers with the digest the broker pinned them by (owner Q9), for a mocked service only", () => {
    const decisions = [{ name: "a-preprod", mode: "preprod" as const, reason: "configured_preprod" as const }, { name: "b-auto", mode: "mocked" as const, reason: "probe_failed_fell_back" as const }];
    const additions = new Map([["a-preprod", { count: 2, digest: sha("d") }], ["b-auto", { count: 3, digest: sha("e") }]]);
    const entries = evidenceServices(decisions, new Map(), new Map(), additions);
    expect(entries).toEqual([{ name: "a-preprod", mode: "preprod" }, { name: "b-auto", mode: "mocked", newAnswers: 3, newAnswersDigest: sha("e") }]);
    expect(EvidenceEnvironmentSchema.safeParse({ tier: "sandbox", envRevision: 1, services: entries, data: "synthetic", accounts: [] }).success).toBe(true);
    expect(evidenceServices(decisions, new Map(), new Map())[1]).toEqual({ name: "b-auto", mode: "mocked" });
  });
});
