// Test services, slice 3 (s3-fakes-store): the routes for a hand-written answer set (a fake), through the whole broker with live browser sessions. Behind `tx`; browser only; the org, the role, the sign-in time and
// `schema_synth` all come from the session and the project's approved environment, never from the request; a set is scanned before it is stored; a decision is one decision on one digest.
import { afterEach, describe, expect, it } from "vitest";
import { FixtureSetSchema, fixtureEntry, fixtureSetDigest, projectPk, testEnvDigest, type FixtureSet, type TestEnvProdDeny, type TestEnvironmentBody } from "@agentx/contracts";
import { createFixtureStore, createMemoryFixturePorts } from "../../packages/broker/src/test-env/fixture-store.js";
import { testServicesEnabled } from "../../packages/broker/src/test-env/test-services-switch.js";
import { environmentSynthesisesFor } from "../../packages/broker/src/aws/developer-routes/fixtures.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { NAME, draftBody, setupWizardBench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const on = () => { process.env.TEST_SERVICES_ENABLED = "1"; };
/**
 * The project's approved environment, rewritten to `environment` after a normal approval (a setup draft never carries dependencies or a production list, so the test puts them where an edit and an approval would leave them).
 */
const approved = async (t: Awaited<ReturnType<typeof bench>>["t"], environment: TestEnvironmentBody) => {
  process.env.TEST_ENVIRONMENT_ENABLED = "1";
  await t.approveFirst();
  const revision = t.db.find((item) => item.entityType === "TEST_ENV_REVISION" && item.pk === projectPk(TEST_ORG, NAME))[0]!;
  t.db.set({ ...revision, environment, digest: testEnvDigest(environment) });
};
const BASE = `/v1/app/projects/${NAME}/fixtures`;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz";

const dependency = { id: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: ["/requestedAt"], query: ["customer"] };
const json = "application/json";
const request = (amount: number) => ({ method: "POST" as const, path: "/v1/charges", query: [{ name: "customer", value: "c1" }], contentType: json, body: JSON.stringify({ amount }) });
const answer = (body: unknown) => ({ status: 200, headers: [{ name: "etag" as const, value: "abc" }], contentType: json, body: JSON.stringify(body), latencyMs: 0 });
function makeSet(over: Record<string, unknown> = {}): FixtureSet {
  const shell = { dependency, match };
  return FixtureSetSchema.parse({
    schemaVersion: 2, dependency, origin: "written", revision: 1, writtenBy: "maya", syntheticOnly: true, match,
    entries: [1, 2, 3].map((n) => fixtureEntry(shell, request(n), answer({ ok: true, id: `ch_${String(n)}` }))), faults: [], ...over,
  });
}

async function bench(options: { maya?: "viewer" | "contributor" | "maintainer" | "none" } = {}) {
  const ports = createMemoryFixturePorts();
  const touched: string[] = [];
  const objects = { ...ports.objects, putIfAbsent: (...a: Parameters<typeof ports.objects.putIfAbsent>) => { touched.push("put"); return ports.objects.putIfAbsent(...a); } };
  const denies: TestEnvProdDeny[] = [];
  const factory = (denyFor: (orgId: string) => Promise<TestEnvProdDeny>) => createFixtureStore({ enabled: () => testServicesEnabled(), objects, index: ports.index, denyFor: async (org) => { const deny = await denyFor(org); denies.push(deny); return deny; }, now: () => new Date() });
  const t = await setupWizardBench({ modelProxy: true, brokerExtra: { fixtureStore: factory } });
  if (options.maya !== undefined && options.maya !== "none") await t.person(MAYA, "member", options.maya);
  else if (options.maya === "none") await t.person(MAYA, "member");
  /** Org-level store as another org's request would see it, to plant a set the caller must never reach. */
  const store = factory(() => Promise.resolve({ accountIds: [], hosts: [], arnPrefixes: [] }));
  return { t, ports, touched, store, denies };
}
const error = (reply: { body: Record<string, unknown> }) => reply.body.error as { code: string; message: string };

describe("behind tx", () => {
  it("every path is not found unless the switch is exactly 1, and nothing is stored", async () => {
    const { t, ports, touched } = await bench();
    const digest = fixtureSetDigest(makeSet());
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.TEST_SERVICES_ENABLED; else process.env.TEST_SERVICES_ENABLED = value;
      expect((await t.web(OMAR, "POST", BASE, { set: makeSet() })).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "GET", `${BASE}/${digest}`)).status).toBe(404);
      for (const action of ["approve", "reject", "withdraw"]) expect((await t.web(OMAR, "POST", `${BASE}/${digest}/${action}`, {})).status).toBe(404);
    }
    expect(touched).toEqual([]);
    expect(ports.objects.dump().size).toBe(0);
  });
  it("is not found when the install has no fixture store, even with tx on", async () => {
    const t = await setupWizardBench({});
    on();
    expect((await t.web(OMAR, "POST", BASE, { set: makeSet() })).status).toBe(404);
  });
});

describe("who may", () => {
  it("a token is refused for every method, before anything is read or written", async () => {
    const { t, touched } = await bench();
    on();
    const digest = fixtureSetDigest(makeSet());
    for (const [method, path, body] of [["POST", BASE, { set: makeSet() }], ["GET", `${BASE}/${digest}`, undefined], ["POST", `${BASE}/${digest}/approve`, {}]] as const) {
      const reply = await t.dev(OMAR, method, path, body);
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(JSON.stringify(reply.body)).toContain("Use a live browser session");
    }
    expect(touched).toEqual([]);
  });
  it("a member with no role on the project learns nothing about it", async () => {
    const { t, touched } = await bench({ maya: "none" });
    on();
    expect((await t.web(MAYA, "POST", BASE, { set: makeSet() })).status).toBe(404);
    expect((await t.web(MAYA, "GET", `${BASE}/${fixtureSetDigest(makeSet())}`)).status).toBe(404);
    expect(touched).toEqual([]);
  });
  it("a viewer and a contributor may read a review but cannot add or decide anything", async () => {
    for (const role of ["viewer", "contributor"] as const) {
      const { t, store, touched } = await bench({ maya: role });
      on();
      const planted = await store.submit(TEST_ORG, makeSet(), { actor: OMAR.developerId, recordedFrom: "written" });
      expect(planted.ok).toBe(true);
      const digest = fixtureSetDigest(makeSet());
      touched.length = 0;
      const review = await t.web(MAYA, "GET", `${BASE}/${digest}`);
      expect(review.status, role).toBe(200);
      expect(review.body).toMatchObject({ status: "pending", canDecide: false });
      expect((await t.web(MAYA, "POST", BASE, { set: makeSet({ revision: 2 }) })).status, role).toBe(403);
      for (const action of ["approve", "reject", "withdraw"]) expect((await t.web(MAYA, "POST", `${BASE}/${digest}/${action}`, {})).status, `${role} ${action}`).toBe(403);
      expect(touched).toEqual([]);
      expect(((await store.record(TEST_ORG, digest)) as { record: { status: string } }).record.status).toBe("pending");
    }
  });
});

describe("a hand-written set", () => {
  it("is stored pending with its review and its approve_fixture_set card, and the same set again is the same set", async () => {
    const { t } = await bench({ maya: "maintainer" });
    on();
    const set = makeSet();
    const first = await t.web(MAYA, "POST", BASE, { set });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: "pending", canDecide: true, review: { digest: fixtureSetDigest(set), counts: { entries: 3, faults: 0 }, scan: { clean: true } }, card: { kind: "approve_fixture_set", dependency: "payments-api", origin: "written", entries: 3, schemaSynth: false, firstFromTestAccount: false } });
    const again = await t.web(MAYA, "POST", BASE, { set });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "pending", review: { digest: fixtureSetDigest(set) } });
    expect((await t.web(MAYA, "GET", `${BASE}/${fixtureSetDigest(set)}`)).body).toMatchObject({ status: "pending", review: { digest: fixtureSetDigest(set) } });
  });
  it("must be written by hand: a recorded set, a v1 set, extra fields and a body that is not the one shape are refused", async () => {
    const { t, ports } = await bench({ maya: "maintainer" });
    on();
    for (const body of [{ set: makeSet({ origin: "recorded", recordedAt: "2026-11-01T00:00:00.000Z", writtenBy: undefined }) }, { set: { ...makeSet(), schemaVersion: 1 } }, { set: "nonsense" }, { set: makeSet(), orgId: OTHER_ORG }, {}, { sets: [makeSet()] }]) {
      expect((await t.web(MAYA, "POST", BASE, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(ports.objects.dump().size).toBe(0);
  });
  it.each([
    ["an email address", () => answer({ contact: "jane.roe@acme-corp.com" })],
    ["a credential", () => answer({ debug: `key ${"AKIA"}${"ABCDEFGHIJKLMNOP"}` })],
  ])("is scanned before it is stored: %s stops it, says only that the guard stopped it, and stores nothing", async (_label, make) => {
    const { t, ports, touched } = await bench({ maya: "maintainer" });
    on();
    const shell = { dependency, match };
    const reply = await t.web(MAYA, "POST", BASE, { set: makeSet({ entries: [fixtureEntry(shell, request(1), make())] }) });
    expect(reply.status).toBe(400);
    expect(error(reply).message).toContain("was not stored");
    expect(JSON.stringify(reply.body)).not.toContain("jane.roe");
    expect(JSON.stringify(reply.body)).not.toContain("AKIA");
    expect(touched).toEqual([]);
    expect(ports.objects.dump().size).toBe(0);
  });
  it("is scanned with the production list of the project's approved environment", async () => {
    const { t, denies, ports } = await bench({ maya: "maintainer" });
    await approved(t, draftBody({ prodDeny: { accountIds: [], hosts: ["api.example-pay.com"], arnPrefixes: [] } }));
    on();
    const shell = { dependency, match };
    const reply = await t.web(MAYA, "POST", BASE, { set: makeSet({ entries: [fixtureEntry(shell, request(1), answer({ link: "https://api.example-pay.com/receipt" }))] }) });
    expect(reply.status).toBe(400);
    expect(denies.at(-1)).toEqual({ accountIds: [], hosts: ["api.example-pay.com"], arnPrefixes: [] });
    expect(ports.objects.dump().size).toBe(0);
  });
});

describe("deciding", () => {
  it("approves, and delivery follows; a decided set is not decided again; only an approved set can be withdrawn, and it stays withdrawn", async () => {
    const { t, store } = await bench({ maya: "maintainer" });
    on();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    await t.web(MAYA, "POST", BASE, { set });
    expect((await t.web(MAYA, "POST", `${BASE}/${digest}/withdraw`, {})).status).toBe(409);
    expect(await t.web(MAYA, "POST", `${BASE}/${digest}/approve`, {})).toMatchObject({ status: 200, body: { status: "approved", digest } });
    expect((await store.deliver(TEST_ORG, digest)).ok).toBe(true);
    expect((await t.web(MAYA, "POST", `${BASE}/${digest}/approve`, {})).status).toBe(409);
    expect((await t.web(MAYA, "POST", `${BASE}/${digest}/reject`, {})).status).toBe(409);
    expect(await t.web(MAYA, "POST", `${BASE}/${digest}/withdraw`, {})).toMatchObject({ status: 200, body: { status: "withdrawn" } });
    expect(await store.deliver(TEST_ORG, digest)).toEqual({ ok: false, reason: "not_approved" });
    expect((await t.web(MAYA, "POST", `${BASE}/${digest}/approve`, {})).status).toBe(409);
  });
  it("rejects a pending set for good", async () => {
    const { t, store } = await bench({ maya: "maintainer" });
    on();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    await t.web(MAYA, "POST", BASE, { set });
    expect(await t.web(MAYA, "POST", `${BASE}/${digest}/reject`, {})).toMatchObject({ status: 200, body: { status: "rejected" } });
    expect((await t.web(MAYA, "POST", `${BASE}/${digest}/approve`, {})).status).toBe(409);
    expect((await store.deliver(TEST_ORG, digest)).ok).toBe(false);
  });
  it("takes nothing from the body: the org, the role, the sign-in time and schema_synth are not fields of a decision", async () => {
    const { t, store } = await bench({ maya: "maintainer" });
    on();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    await t.web(MAYA, "POST", BASE, { set });
    for (const body of [{ orgId: OTHER_ORG }, { role: "maintainer" }, { signedInAt: new Date().toISOString() }, { schemaSynth: false }, { actor: "x" }]) {
      expect((await t.web(MAYA, "POST", `${BASE}/${digest}/approve`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(((await store.record(TEST_ORG, digest)) as { record: { status: string } }).record.status).toBe("pending");
  });
  it("another org's set is not found: not read, not decided, whatever the caller's role", async () => {
    const { t, store } = await bench({ maya: "maintainer" });
    on();
    const planted = await store.submit(OTHER_ORG, makeSet({ revision: 9 }), { actor: "someone", recordedFrom: "written" });
    expect(planted.ok).toBe(true);
    const digest = fixtureSetDigest(makeSet({ revision: 9 }));
    expect((await t.web(MAYA, "GET", `${BASE}/${digest}`)).status).toBe(404);
    expect((await t.web(OMAR, "GET", `${BASE}/${digest}`)).status).toBe(404);
    for (const action of ["approve", "reject", "withdraw"]) expect((await t.web(OMAR, "POST", `${BASE}/${digest}/${action}`, {})).status, action).toBe(404);
    expect(((await store.record(OTHER_ORG, digest)) as { record: { status: string } }).record.status).toBe("pending");
  });
  it("an org owner counts as a maintainer", async () => {
    const { t } = await bench();
    on();
    const set = makeSet();
    expect((await t.web(OMAR, "POST", BASE, { set })).status).toBe(201);
    expect((await t.web(OMAR, "POST", `${BASE}/${fixtureSetDigest(set)}/approve`, {})).status).toBe(200);
  });
});

describe("a set the environment backs with schema_synth is high: it is approved only with a fresh sign-in", () => {
  const envWith = (digest: string, unmatched: "fail" | "schema_synth") => draftBody({
    dependencies: [{
      id: "payments-api", name: "Payments", kind: "http_api", family: "http:api.example-pay.com", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
      backing: { kind: "fake", fixtureSetRef: digest, unmatched }, connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round",
    }],
  });
  it("refuses an old sign-in, then approves after a fresh one", async () => {
    const { t, store } = await bench();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    await approved(t, envWith(digest, "schema_synth"));
    on();
    await t.web(OMAR, "POST", BASE, { set });
    expect((await t.web(OMAR, "GET", `${BASE}/${digest}`)).body).toMatchObject({ card: { schemaSynth: true } });
    t.ageSignIn(OMAR, 30);
    const stale = await t.web(OMAR, "POST", `${BASE}/${digest}/approve`, {});
    expect(stale.status).toBe(403);
    expect(error(stale).code).toBe("REAUTH_REQUIRED");
    t.ageSignIn(OMAR, undefined);
    expect((await t.web(OMAR, "POST", `${BASE}/${digest}/approve`, {})).status).toBe(403);
    t.ageSignIn(OMAR, 1);
    expect((await t.web(OMAR, "POST", `${BASE}/${digest}/approve`, {})).status).toBe(200);
    expect((await store.deliver(TEST_ORG, digest)).ok).toBe(true);
  });
  it("a set the environment answers with `fail` is medium: an old sign-in approves it", async () => {
    const { t } = await bench();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    await approved(t, envWith(digest, "fail"));
    on();
    await t.web(OMAR, "POST", BASE, { set });
    t.ageSignIn(OMAR, 30);
    expect((await t.web(OMAR, "POST", `${BASE}/${digest}/approve`, {})).status).toBe(200);
  });
  it("reads schema_synth from the environment, by digest or by dependency id, never from the request", () => {
    const dependencies = [{ id: "payments-api", backing: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "schema_synth" } }, { id: "db", backing: { kind: "local", catalogId: "postgres@16" } }];
    expect(environmentSynthesisesFor(dependencies, "a".repeat(64), "other")).toBe(true);
    expect(environmentSynthesisesFor(dependencies, "b".repeat(64), "payments-api")).toBe(true);
    expect(environmentSynthesisesFor(dependencies, "b".repeat(64), "other")).toBe(false);
    expect(environmentSynthesisesFor(dependencies.map((d) => ({ ...d, backing: { ...d.backing, unmatched: "fail" } })), "a".repeat(64), "payments-api")).toBe(false);
    expect(environmentSynthesisesFor(undefined, "a".repeat(64), "payments-api")).toBe(false);
  });
});
