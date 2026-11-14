// TE-F1e: the ProductModelEgress function's own rules, beyond F1-a's suite: whose call it is comes from the capability and State only; every refusal makes no model call, reads no key and holds nothing;
// the two-company kit's IAM half (the role's policy TEXT and the session policy, evaluated by the fake); a warm instance never crosses companies; 401/403 warns the source; Vertex waits for F1-f; logs are
// fixed fields; and the production wiring is dark.
import { e2eSecretSpellings } from "@rovara-code/contracts";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { productModelEgressDependencies } from "../../packages/broker/src/product-ai/egress-lambda.js";
import { proxyCacheKey } from "../../packages/broker/src/product-ai/proxy-secret.js";
import { VERTEX_NOT_RUN_SENTENCE, NO_GOOGLE_TOKEN_SOURCE } from "../../packages/broker/src/product-ai/seams.js";
import { COMPANY_A, COMPANY_B, FAKE_SECRET_ARN_PREFIX, cloudEgressWorld, collectHandler, productSecretName, type CloudEgressWorld } from "../support/product-model-egress-world.js";

const frameFor = (world: CloudEgressWorld, rowKey: "gemini" | "openai" | "vertex" = "gemini", prompt = "hello") => {
  const row = world.rows[rowKey]!;
  const path = rowKey === "gemini" ? "/v1beta/models/fixture-small:generateContent" : rowKey === "vertex" ? "/v1/projects/fixture-project-1/locations/us-central1/publishers/google/models/fixture-small:generateContent" : "/v1/chat/completions";
  const body = rowKey === "openai" ? { model: "fixture-small", messages: [{ role: "user", content: prompt }] } : { contents: [{ parts: [{ text: prompt }] }] };
  return { row: row.id, method: "POST", path, query: "", headers: [["content-type", "application/json"]] as Array<[string, string]>, body: Buffer.from(JSON.stringify(body)).toString("base64") };
};
const request = async (world: CloudEgressWorld, capability: string, frame = frameFor(world)) => collectHandler(world.deps, { v: 1, op: "forward", capability, frame });
const meterItems = (world: CloudEgressWorld) => world.table.find((item) => String(item.pk).startsWith("product-ai-meter#"));
const secretReads = (world: CloudEgressWorld) => world.secrets.calls.filter((call) => call.action === "GetSecretValue").length;

async function expectRefusedWithNothing(world: CloudEgressWorld, run: () => Promise<{ status?: number; settle?: Record<string, unknown> }>, word: string): Promise<void> {
  const calls = world.provider.calls.length;
  const reads = secretReads(world);
  const before = JSON.stringify(meterItems(world));
  const answer = await run();
  expect(answer.settle).toMatchObject({ refusal: word, costMicros: 0 });
  expect(world.provider.calls.length, "a model call was made").toBe(calls);
  expect(JSON.stringify(meterItems(world)), "the meter moved").toBe(before);
  if (word === "not_found" || word === "bad_request" || word === "too_large") expect(secretReads(world), "a key was read").toBe(reads);
}

describe("ProductModelEgress function", () => {
  it("answers a capability it cannot verify, or an operation that is not live, with the same not_found, reading no key and holding nothing", async () => {
    const world = await cloudEgressWorld();
    const good = await world.capability(COMPANY_A, "gemini");
    expect((await request(world, good)).settle).toMatchObject({ class: "ok" });
    const missing = await request(world, await world.capability(COMPANY_A, "no-such-source"));
    const cases: Array<[string, string]> = [
      ["another key", good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA")],
      ["expired", await world.capability(COMPANY_A, "gemini", { expiresAt: Math.floor(Date.UTC(2026, 10, 14, 11) / 1000) })],
      ["a stale fence", await world.capability(COMPANY_A, "gemini", { fence: 2 })],
      ["a hold purpose on the per-call path", await world.capability(COMPANY_A, "gemini", { purpose: "eval-hold" })],
      ["an unknown operation", await world.capability(COMPANY_A, "gemini", { operationId: "99999999-9999-4999-8999-999999999999" })],
    ];
    for (const [label, capability] of cases) {
      await expectRefusedWithNothing(world, async () => {
        const answer = await request(world, capability);
        expect(answer.body, label).toBe(missing.body);
        return answer;
      }, "not_found");
    }
  });

  it("refuses when the operation finished, the workspace moved on, or the task closed", async () => {
    for (const change of ["operation", "workspace", "task"] as const) {
      const world = await cloudEgressWorld();
      const capability = await world.capability(COMPANY_A, "gemini");
      const operation = world.table.find((item) => String(item.sk).startsWith("OPERATION#") && item.orgId === COMPANY_A.orgId && item.workspaceId !== undefined)[0]!;
      const pointer = world.table.find((item) => item.pk === operation.pk && item.sk === "DEVELOPER_TASK")[0]!;
      if (change === "operation") world.table.set({ ...operation, status: "SUCCEEDED" });
      if (change === "workspace") world.table.set({ ...world.table.get(String(operation.pk), "META")!, status: "IDLE" });
      if (change === "task") world.table.set({ ...world.table.get(`DEVTASK#${String(pointer.taskId)}`, "META")!, closedAt: "2026-11-14T00:00:00.000Z" });
      await expectRefusedWithNothing(world, () => request(world, capability), "not_found");
    }
  });

  it("with the productModels gate off, answers not_found for every call and reads nothing", async () => {
    const world = await cloudEgressWorld({ gateOn: () => false });
    for (const row of ["gemini", "openai", "vertex"] as const) await expectRefusedWithNothing(world, async () => request(world, await world.capability(COMPANY_A, row), frameFor(world, row)), "not_found");
    expect(world.secrets.calls).toHaveLength(0);
  });

  it("refuses a frame or envelope that tries to name a company, a project or a source (strict), before anything is read", async () => {
    const world = await cloudEgressWorld();
    const capability = await world.capability(COMPANY_A, "gemini");
    for (const extra of [{ orgId: COMPANY_B.orgId }, { project: "p-gemini" }, { source: "gemini" }]) {
      await expectRefusedWithNothing(world, () => collectHandler(world.deps, { v: 1, op: "forward", capability, frame: { ...frameFor(world), ...extra } }), "bad_request");
      await expectRefusedWithNothing(world, () => collectHandler(world.deps, { v: 1, op: "forward", capability, frame: frameFor(world), ...extra }), "bad_request");
    }
    // A body over Cloud's 4 MiB is refused, never truncated.
    const big = { ...frameFor(world), body: Buffer.alloc(4 * 1024 * 1024 + 3).toString("base64") };
    await expectRefusedWithNothing(world, () => collectHandler(world.deps, { v: 1, op: "forward", capability, frame: big }), "too_large");
  });

  it("A's capability naming B's source is not_found, A's company comes from State and never from the frame, and A's calls never move B's meter", async () => {
    const world = await cloudEgressWorld();
    const answer = await request(world, await world.capability(COMPANY_A, "private-source-b"));
    expect(answer.settle).toMatchObject({ refusal: "not_found" });
    expect(answer.body).toBe((await request(world, await world.capability(COMPANY_A, "no-such-source"))).body);
    expect((await request(world, await world.capability(COMPANY_A, "gemini"))).settle).toMatchObject({ class: "ok" });
    expect(meterItems(world).filter((item) => String(item.pk).includes(COMPANY_B.orgId))).toHaveLength(0);
    expect(world.secrets.calls.filter((call) => call.sessionOrg !== undefined).every((call) => call.sessionOrg === COMPANY_A.orgId)).toBe(true);
  });

  it("a frame header that names another company changes nothing: A's key is placed, A's meter moves, B's never", async () => {
    const world = await cloudEgressWorld();
    const frame = { ...frameFor(world), headers: [["content-type", "application/json"], ["x-rovara-org", COMPANY_B.orgId], ["x-org-id", COMPANY_B.orgId], ["x-rovara-project", "p-gemini"]] as Array<[string, string]> };
    const answer = await request(world, await world.capability(COMPANY_A, "gemini"), frame);
    expect(answer.settle).toMatchObject({ class: "ok" });
    const placed = JSON.stringify(world.provider.calls[0]!.headers);
    expect(placed.includes(world.credentialOf(COMPANY_A, "gemini"))).toBe(true);
    expect(placed.includes(world.credentialOf(COMPANY_B, "gemini"))).toBe(false);
    expect(placed.includes(COMPANY_B.orgId)).toBe(false);
    expect(meterItems(world).filter((item) => String(item.pk).includes(COMPANY_B.orgId))).toHaveLength(0);
  });

  it("a source record handed back for another company, project or row is refused (the function never trusts its loader), with no key read", async () => {
    for (const change of ["orgId", "project", "rowId"] as const) {
      const holder: { world?: CloudEgressWorld } = {};
      const world = await cloudEgressWorld({ override: (deps) => ({ ...deps, loadSource: async (orgId, project, rowId) => {
        const real = await deps.loadSource(orgId, project, rowId);
        if (real === undefined) return undefined;
        const other = holder.world!.sources.get(`${COMPANY_B.orgId}|${project}`)!;
        return change === "orgId" ? other : change === "project" ? { ...real, project: "p-openai" } : { ...real, rowId: "openai" };
      } }) });
      holder.world = world;
      await expectRefusedWithNothing(world, async () => request(world, await world.capability(COMPANY_A, "gemini")), "not_found");
    }
  });

  it("an Azure source whose resource host is outside the row's domain is refused before any call", async () => {
    const world = await cloudEgressWorld();
    const id = `${COMPANY_A.orgId}|p-azure-openai`;
    world.sources.set(id, { ...world.sources.get(id)!, resourceHost: "fixture-resource.evil.example" });
    const row = world.rows.azure!;
    const frame = { row: row.id, method: "POST", path: `/openai/deployments/${row.azure!.deployment}/chat/completions`, query: `api-version=${row.azure!.apiVersion}`, headers: [["content-type", "application/json"]] as Array<[string, string]>, body: Buffer.from(JSON.stringify({ model: "fixture-small", messages: [] })).toString("base64") };
    const calls = world.provider.calls.length;
    const answer = await request(world, await world.capability(COMPANY_A, "azure-openai"), frame);
    expect(answer.settle).toMatchObject({ costMicros: 0 });
    expect(["ssrf", "bad_request", "not_allowed"]).toContain(answer.settle?.refusal);
    expect(world.provider.calls.length).toBe(calls);
  });

  it("two-company IAM: A's proxy session cannot read B's secret (the role's policy text), nor another A secret (the session policy), and a store session reads nothing", async () => {
    const world = await cloudEgressWorld();
    const bSecret = `${FAKE_SECRET_ARN_PREFIX}${productSecretName(COMPANY_B.orgId, "p-gemini", "gemini")}-AbCdEf`;
    const aProxy = await world.secrets.client(COMPANY_A.orgId, { "rovara:org": COMPANY_A.orgId, "rovara:purpose": "proxy" });
    await expect(aProxy.send(new GetSecretValueCommand({ SecretId: bSecret }))).rejects.toThrow(/not authorized/u);
    // The positive control: the same session reads A's own secret, so the refusal above is the policy, not a broken fake.
    expect((await aProxy.send(new GetSecretValueCommand({ SecretId: `${FAKE_SECRET_ARN_PREFIX}${productSecretName(COMPANY_A.orgId, "p-gemini", "gemini")}-AbCdEf` }))).SecretString).toBe(world.credentialOf(COMPANY_A, "gemini"));
    // An org tag naming B with A's purpose is still only B's own: the tag decides, and the function only ever tags with the capability's company.
    await expect(world.secrets.client(COMPANY_A.orgId, { "rovara:org": COMPANY_A.orgId, "rovara:purpose": "store" })).rejects.toThrow(/trust policy/u);
    // Through the function: the session policy narrows A's session to the one secret its source names.
    const source = world.sources.get(`${COMPANY_A.orgId}|p-gemini`)!;
    // The session policy names `source.secretName` only; the ARN points at another A secret (its real version, so only the session policy can refuse it: the role's policy alone would allow an A secret).
    const otherName = productSecretName(COMPANY_A.orgId, "p-openai", "openai");
    const narrowed = await world.deps.keys.keyFor(COMPANY_A.orgId, { ...source, sourceId: "narrowing-probe", secretArn: `${FAKE_SECRET_ARN_PREFIX}${otherName}-AbCdEf`, secretVersionId: world.secrets.stored(otherName)!.history[0]!.id });
    expect(narrowed).toBeUndefined();
    // And a source handed over under the wrong company is refused before any session.
    const calls = world.secrets.calls.length;
    expect(await world.deps.keys.keyFor(COMPANY_B.orgId as never, source)).toBeUndefined();
    expect(world.secrets.calls.length).toBe(calls);
  });

  it("ONE warm instance serving A then B then A never reuses a session, key or token across companies; the cache is keyed by the loaded source only", async () => {
    const world = await cloudEgressWorld();
    for (const company of [COMPANY_A, COMPANY_B, COMPANY_A, COMPANY_B]) {
      for (const row of ["gemini", "vertex"] as const) {
        world.provider.reset();
        const answer = await request(world, await world.capability(company, row), frameFor(world, row));
        expect(answer.settle, `${company.label} ${row}`).toMatchObject({ class: "ok" });
        const placed = JSON.stringify(world.provider.calls[0]!.headers);
        expect(placed.includes(world.credentialOf(company, row)), `${company.label} ${row}`).toBe(true);
        expect(placed.includes(world.credentialOf(company === COMPANY_A ? COMPANY_B : COMPANY_A, row))).toBe(false);
      }
    }
    // One session (one secret read) per company and source: the second A call came from A's cache entry.
    expect(secretReads(world)).toBe(2);
    expect(world.deps.keys.size()).toBe(2);
    const source = world.sources.get(`${COMPANY_A.orgId}|p-gemini`)!;
    expect(proxyCacheKey(COMPANY_A.orgId as never, source)).not.toBe(proxyCacheKey(COMPANY_B.orgId as never, world.sources.get(`${COMPANY_B.orgId}|p-gemini`)!));
    expect(proxyCacheKey(COMPANY_A.orgId as never, source)).not.toBe(proxyCacheKey(COMPANY_A.orgId as never, { ...source, secretVersionId: "rotated" }));
  });

  it("a 401 or 403 body is replaced with the fixed sentence and the source gets a warning; a provider 429 goes back unchanged", async () => {
    const world = await cloudEgressWorld();
    const key = world.credentialOf(COMPANY_A, "gemini");
    for (const status of [401, 403] as const) {
      world.provider.script({ status, body: JSON.stringify({ error: { message: `bad key ${key}` } }) });
      const answer = await request(world, await world.capability(COMPANY_A, "gemini"));
      expect(answer.status).toBe(status);
      expect(answer.body).toContain("The product key was refused by the provider. Check it in Settings.");
      for (const spelling of e2eSecretSpellings(key)) expect(answer.body.includes(spelling)).toBe(false);
    }
    expect(world.warnings).toEqual([{ orgId: COMPANY_A.orgId, project: "p-gemini", sourceId: "gemini", status: 401 }, { orgId: COMPANY_A.orgId, project: "p-gemini", sourceId: "gemini", status: 403 }]);
    world.provider.script({ status: 429, body: "{\"error\":{\"code\":429}}" });
    const limited = await request(world, await world.capability(COMPANY_A, "gemini"));
    expect(limited.status).toBe(429);
    expect(limited.body).toBe("{\"error\":{\"code\":429}}");
    expect(limited.headers.some(([name]) => name === "x-rovara-refusal")).toBe(false);
  });

  it("a Rovara cap refusal is a 429 in the family's shape with x-rovara-refusal: cap, and a model call refused for its cap makes no call", async () => {
    const world = await cloudEgressWorld();
    await world.setCap(COMPANY_A, 1);
    await expectRefusedWithNothing(world, async () => {
      const answer = await request(world, await world.capability(COMPANY_A, "gemini"));
      expect(answer.status).toBe(429);
      expect(answer.headers).toContainEqual(["x-rovara-refusal", "cap"]);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
      return answer;
    }, "cap");
  });

  it("a Vertex source answers the fixed not-run sentence until F1-f's token source exists, with no call and no key read", async () => {
    const world = await cloudEgressWorld({ override: (deps) => ({ ...deps, tokens: NO_GOOGLE_TOKEN_SOURCE }) });
    await expectRefusedWithNothing(world, async () => {
      const answer = await request(world, await world.capability(COMPANY_A, "vertex"), frameFor(world, "vertex"));
      expect(answer.body).toContain(VERTEX_NOT_RUN_SENTENCE);
      return answer;
    }, "not_allowed");
    expect(secretReads(world)).toBe(0);
  });

  it("logs fixed fields only: never a body, a header value, a query, a company id, a capability or a key", async () => {
    const world = await cloudEgressWorld();
    const key = world.credentialOf(COMPANY_A, "openai");
    world.provider.script({ status: 400, body: JSON.stringify({ error: { message: `you sent ${key} with prompt ${COMPANY_A.canary}` } }) });
    const capability = await world.capability(COMPANY_A, "openai");
    await request(world, capability, frameFor(world, "openai", COMPANY_A.canary));
    await request(world, await world.capability(COMPANY_A, "no-such-source"), frameFor(world, "openai", COMPANY_A.canary));
    const lines = world.logs();
    expect(lines.length).toBeGreaterThan(1);
    const allowed = new Set(["component", "event", "row", "status", "class", "refusal", "cost", "inputTokens", "outputTokens", "ms"]);
    for (const line of lines) for (const field of Object.keys(JSON.parse(line) as Record<string, unknown>)) expect(allowed.has(field), field).toBe(true);
    const text = lines.join("\n");
    for (const needle of [...e2eSecretSpellings(key), COMPANY_A.canary, COMPANY_A.orgId, capability, "fixture-small", "p-openai"]) expect(text.includes(needle), needle).toBe(false);
  });

  it("production wiring is dark: with F1-d not bound, every call is not_found, and it refuses to start unconfigured", async () => {
    expect(() => productModelEgressDependencies({})).toThrow(/not configured/u);
    const deps = productModelEgressDependencies({ STATE_TABLE_NAME: "state", PRODUCT_MODEL_EGRESS_KEY_ARN: "arn:aws:kms:us-west-2:111122223333:key/x", AWS_REGION: "us-west-2", AGENTX_ENV: "staging", AGENTX_ACCOUNT_ID: "111122223333" }, () => undefined);
    expect(await deps.gate("org_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(await deps.loadSource("org_aaaaaaaaaaaaaaaaaaaa", "web", "gemini")).toBeUndefined();
  });
});
