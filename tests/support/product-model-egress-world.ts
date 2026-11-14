// TE-F1e: the ProductModelEgress function composed with fakes, behind the worker's REAL Cloud adapter, as a `ModelEgressWorld` for F1-a's conformance suite and the two-company kit (DECISIONS 150(c)).
//
// The chain under test is the production chain: the Cloud adapter (packages/worker/src/model-egress-cloud.ts) encodes the Invoke payload; a fake Lambda runs the function's streaming entry
// (`streamProductModelEgress`) in process and hands its record stream back split into odd-sized payload chunks; the function verifies a capability signed with a real P-256 key, reads the operation from a fake
// State table (FakeDynamoDb, with condition semantics), loads the source from a fake F1-d seam, reads the key through the REAL proxy secret reader over FakeOrgSecrets (which EVALUATES the role's policy text and the
// session policy), reserves and settles on the REAL meter, and calls the conformance suite's fake provider as its transport. Nothing opens a socket and nothing calls AWS.
//
// F1-d is not on this base: the ProductAiSecretsRole policy and the proxy session policy below are LOCAL STAND-INS shaped as te-f1d.md describes them (proxy purpose reads one secret whose rovara:org tag is the
// session's org). 9d replaces them with F1-d's own when it merges.
import { generateKeyPairSync, sign as cryptoSign, randomUUID, type KeyObject } from "node:crypto";
import type { ModelEgressRow, ModelEgressScope, OrgId } from "@rovara-code/contracts";
import { COMPANY_A, COMPANY_B, TWO_COMPANIES, type IsolationCompany } from "../../vendor/rovara-code/packages/testing/dist/isolation/two-company.js";
import { modelEgressIsolation, type ModelEgressWorld } from "../../vendor/rovara-code/packages/testing/dist/ports/model-egress-conformance.js";
import { createFakeProvider } from "../../vendor/rovara-code/packages/testing/dist/ports/model-egress-fake.js";
import { FIXTURE_AZURE_HOST, FIXTURE_VERTEX_CONNECTION, fixtureEgressRows, fixtureKey, fixtureToken } from "../../vendor/rovara-code/packages/testing/dist/ports/model-egress-fixtures.js";
import { signModelEgressCapability, type ModelEgressCapabilityClaims } from "../../packages/broker/src/product-ai/capability.js";
import { handleProductModelEgress, type ProductModelEgressDependencies } from "../../packages/broker/src/product-ai/egress-handler.js";
import { streamProductModelEgress } from "../../packages/broker/src/product-ai/egress-lambda.js";
import { productAiMeterKeys, meterMonthOf } from "../../packages/broker/src/product-ai/meter.js";
import { createOperationScopeReader } from "../../packages/broker/src/product-ai/operation-scope.js";
import { createProxySecretReader } from "../../packages/broker/src/product-ai/proxy-secret.js";
import type { ProviderTransport } from "../../packages/broker/src/product-ai/provider-transport.js";
import type { GoogleTokenSource, ProductSourceForRow } from "../../packages/broker/src/product-ai/seams.js";
import { cloudModelEgressScope, createCloudModelEgress, type CloudInvoke } from "../../packages/worker/src/model-egress-cloud.js";
import type { PolicyStatementJson } from "../../infra/lib/connector-secrets-policy.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { FAKE_BROKER_ROLE_ARN, FakeOrgSecrets } from "./fake-org-secrets.js";

export { COMPANY_A, COMPANY_B, TWO_COMPANIES };
export const WORLD_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
export const WORLD_ENV = "staging";
export const FAKE_SECRET_ARN_PREFIX = "arn:aws:secretsmanager:us-west-2:111122223333:secret:";
export const FAKE_PRODUCT_AI_ROLE_ARN = "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-connector-secrets-product-ai";
const GENEROUS = 1_000_000_000;
const PRIVATE: Record<"A" | "B", string> = { A: "private-source-a", B: "private-source-b" };

/** STAND-IN for F1-d's ProductAiSecretsRole permissions (proxy purpose): read a secret on the org's own product-ai path whose rovara:org tag is the session's org. */
export function productAiPolicyStandIn(env = WORLD_ENV): PolicyStatementJson[] {
  return [{
    Sid: "ProxyReadsOneOrgSecret",
    Effect: "Allow",
    Action: ["secretsmanager:GetSecretValue"],
    Resource: [`${FAKE_SECRET_ARN_PREFIX}agentx/${env}/org-product-ai/\${aws:PrincipalTag/rovara:org}/*`],
    Condition: { StringEquals: { "aws:ResourceTag/rovara:org": "${aws:PrincipalTag/rovara:org}", "aws:PrincipalTag/rovara:purpose": "proxy" } },
  }];
}
/** STAND-IN for F1-d's trust (fork F3): the egress role (the fake's principal) may take the `proxy` purpose with an org tag, and nothing else. */
export function productAiTrustStandIn(): PolicyStatementJson[] {
  return [
    { Effect: "Allow", Principal: { AWS: FAKE_BROKER_ROLE_ARN }, Action: ["sts:AssumeRole"] },
    { Effect: "Allow", Principal: { AWS: FAKE_BROKER_ROLE_ARN }, Action: ["sts:TagSession"], Condition: { StringLike: { "aws:RequestTag/rovara:org": "org_*" }, StringEquals: { "aws:RequestTag/rovara:purpose": "proxy" } } },
  ];
}
/** STAND-IN for F1-d's `productAiProxySessionPolicy` (the test-account `resolveSessionPolicy` pattern): this one secret's ARN only. */
export const proxySessionPolicyStandIn = (secretArnPrefix: string, secretName: string): string =>
  JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: `${secretArnPrefix}${secretName}-??????` }] });

export const productSecretName = (orgId: string, project: string, sourceId: string): string => `agentx/${WORLD_ENV}/org-product-ai/${orgId}/${project}/${sourceId}`;
const projectOf = (sourceId: string): string => `p-${sourceId}`;

export interface WorldOptions {
  /** A seam to break, for the mutation proofs: replaces one dependency of the function. */
  readonly override?: (deps: ProductModelEgressDependencies) => ProductModelEgressDependencies;
  readonly gateOn?: (orgId: OrgId) => boolean;
}

export interface CloudEgressWorld extends ModelEgressWorld {
  readonly table: FakeDynamoDb;
  readonly secrets: FakeOrgSecrets;
  readonly deps: ProductModelEgressDependencies;
  /** Every Invoke payload the adapter sent, as text. */
  readonly payloads: string[];
  readonly invokes: () => number;
  readonly warnings: Array<{ orgId: string; project: string; sourceId: string; status: number }>;
  readonly sources: Map<string, ProductSourceForRow>;
  /** The capability for an operation of `company` on `sourceId`'s project (minted on demand). */
  capability(company: IsolationCompany, sourceId: string, over?: Partial<ModelEgressCapabilityClaims>): Promise<string>;
  readonly keyPair: { publicKey: KeyObject; privateKey: KeyObject };
  readonly rowsList: readonly ModelEgressRow[];
  /** The fake provider as the function's transport sees it (replaceable for the transport-level tests). */
  setTransport(transport: ProviderTransport): void;
  readonly mints: Map<string, number>;
}

export async function cloudEgressWorld(options: WorldOptions = {}): Promise<CloudEgressWorld> {
  const rows = fixtureEgressRows();
  const rowsList = Object.values(rows);
  const provider = createFakeProvider(rowsList);
  let transport: ProviderTransport = provider.transport;
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const table = new FakeDynamoDb();
  const secrets = new FakeOrgSecrets({ env: WORLD_ENV, roleArn: FAKE_PRODUCT_AI_ROLE_ARN, policy: productAiPolicyStandIn(), trust: productAiTrustStandIn(), now: () => WORLD_NOW });
  const sources = new Map<string, ProductSourceForRow>();
  const keyOf = (company: IsolationCompany, sourceId: string): string => fixtureKey(`${company.label}/${sourceId}`);
  const tokenOf = (company: IsolationCompany, sourceId: string): string => fixtureToken(`${company.orgId}/${sourceId}`);
  const isToken = (row: ModelEgressRow): boolean => row.scheme === "gcp-oauth:federation" || row.scheme === "gcp-oauth:key-file";
  const plant = (company: IsolationCompany, sourceId: string, row: ModelEgressRow): void => {
    const project = projectOf(sourceId);
    const name = productSecretName(company.orgId, project, sourceId);
    secrets.seed(name, keyOf(company, sourceId), { "rovara:org": company.orgId, "rovara:use": "product-ai" });
    const versionId = secrets.stored(name)!.history[0]!.id;
    sources.set(`${company.orgId}|${project}`, {
      orgId: company.orgId, project, sourceId, rowId: row.id, scheme: row.scheme,
      ...(row.family === "vertex" ? { vertex: { projectId: FIXTURE_VERTEX_CONNECTION.vertex!.project, location: FIXTURE_VERTEX_CONNECTION.vertex!.location } } : {}),
      ...(row.azure !== undefined ? { resourceHost: FIXTURE_AZURE_HOST } : {}),
      secretName: name, secretArn: `${FAKE_SECRET_ARN_PREFIX}${name}-AbCdEf`, secretVersionId: versionId,
      caps: { taskMicros: GENEROUS, projectMonthMicros: GENEROUS, taskCalls: 10_000, taskConcurrent: 4 }, revision: 1,
    });
  };
  for (const company of TWO_COMPANIES) {
    for (const row of rowsList) plant(company, row.id, row);
    plant(company, PRIVATE[company.label], rows.gemini);
  }
  const rowsById = new Map(rowsList.map((row) => [row.id, row]));
  const mints = new Map<string, number>();
  const tokens: GoogleTokenSource = {
    tokenFor: async (orgId, source) => {
      mints.set(orgId, (mints.get(orgId) ?? 0) + 1);
      const company = TWO_COMPANIES.find((candidate) => candidate.orgId === orgId)!;
      return { ok: true, token: tokenOf(company, source.sourceId) };
    },
  };
  const logs: string[] = [];
  const warnings: CloudEgressWorld["warnings"] = [];
  const base: ProductModelEgressDependencies = {
    publicKey: async () => keyPair.publicKey,
    now: () => WORLD_NOW,
    readScope: createOperationScopeReader({ documentClient: table, tableName: "state" }),
    gate: async (orgId) => options.gateOn?.(orgId) ?? true,
    loadSource: async (orgId, project, rowId) => {
      const source = sources.get(`${orgId}|${project}`);
      return source !== undefined && source.rowId === rowId ? structuredClone(source) : undefined;
    },
    rowFor: (source) => rowsById.get(source.rowId),
    familyOf: (rowId) => rowsById.get(rowId)?.family,
    keys: createProxySecretReader({ roleArn: FAKE_PRODUCT_AI_ROLE_ARN, secretArnPrefix: FAKE_SECRET_ARN_PREFIX, sts: secrets.sts, secretsFor: secrets.secretsFor, sessionPolicy: proxySessionPolicyStandIn, now: () => WORLD_NOW }),
    tokens,
    meter: { documentClient: table, tableName: "state", now: () => WORLD_NOW },
    transport: (request, signal) => transport(request, signal),
    recordWarning: async (orgId, project, sourceId, warning) => { warnings.push({ orgId, project, sourceId, status: warning.status }); },
    log: (fields) => logs.push(JSON.stringify({ component: "product-model-egress", ...fields })),
  };
  const deps = options.override === undefined ? base : options.override(base);

  // The State records of an operation per (company, source): a live CHECKS-round task operation.
  const operations = new Map<string, { workspaceId: string; operationId: string }>();
  const operationFor = (company: IsolationCompany, sourceId: string): { workspaceId: string; operationId: string } => {
    const id = `${company.orgId}|${sourceId}`;
    const held = operations.get(id);
    if (held !== undefined) return held;
    const workspaceId = randomUUID();
    const operationId = randomUUID();
    const taskId = randomUUID();
    const project = projectOf(sourceId);
    table.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, id: operationId, workspaceId, orgId: company.orgId, kind: "task", workflowMode: "CHECKS", fence: 3, status: "RUNNING" });
    table.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", orgId: company.orgId, activeOperationId: operationId, fence: 3, status: "BUSY", projectName: project });
    table.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", taskId });
    table.set({ pk: `DEVTASK#${taskId}`, sk: "META", taskId, orgId: company.orgId, workspaceId, project });
    const made = { workspaceId, operationId };
    operations.set(id, made);
    return made;
  };
  const sign = async (message: Uint8Array): Promise<Uint8Array> => cryptoSign("sha256", message, { key: keyPair.privateKey, dsaEncoding: "der" });
  const capability = async (company: IsolationCompany, sourceId: string, over: Partial<ModelEgressCapabilityClaims> = {}): Promise<string> => {
    const operation = operationFor(company, sourceId);
    return signModelEgressCapability({ v: 1, purpose: "task", workspaceId: operation.workspaceId, operationId: operation.operationId, fence: 3, expiresAt: Math.floor(WORLD_NOW / 1000) + 3600, ...over }, sign);
  };
  // The suite's scope() is synchronous: every capability it may ask for is minted up front.
  const scopes = new Map<string, ModelEgressScope>();
  for (const company of TWO_COMPANIES) for (const id of [...rowsList.map((row) => row.id), PRIVATE.A, PRIVATE.B, "no-such-source"]) scopes.set(`${company.orgId}|${id}`, cloudModelEgressScope(await capability(company, id)));

  const payloads: string[] = [];
  let invokeCount = 0;
  const invoke: CloudInvoke = async (input) => {
    invokeCount += 1;
    const text = new TextDecoder().decode(input.Payload);
    payloads.push(text);
    const written: Uint8Array[] = [];
    await streamProductModelEgress(deps, JSON.parse(text) as unknown, { write: (chunk) => written.push(chunk), end: () => undefined });
    const all = Buffer.concat(written);
    // Odd-sized payload chunks: a record is split across chunks, and one chunk holds several records.
    const pieces: Uint8Array[] = [];
    for (let at = 0, size = 3; at < all.byteLength; at += size, size = (size * 7) % 23 + 1) pieces.push(new Uint8Array(all.subarray(at, at + size)));
    return { StatusCode: 200, EventStream: (async function* () { for (const piece of pieces) yield { PayloadChunk: { Payload: piece } }; yield { InvokeComplete: {} }; })() };
  };
  const adapterLogs: string[] = [];
  const adapter = createCloudModelEgress({ functionArn: "arn:aws:lambda:us-west-2:111122223333:function:agentx-staging-product-model-egress", invoke, log: (fields) => adapterLogs.push(JSON.stringify(fields)) });

  const world: CloudEgressWorld = {
    adapter,
    rows,
    rowsList,
    connection: FIXTURE_VERTEX_CONNECTION,
    scope: (company, sourceId) => scopes.get(`${company.orgId}|${sourceId}`) ?? scopes.get(`${company.orgId}|no-such-source`)!,
    brokenScope(mode) {
      switch (mode) {
        case "throws":
          return Object.defineProperty({}, "capability", { get: () => { throw new Error("the company resolver failed"); } }) as unknown as ModelEgressScope;
        case "undefined":
          return undefined as unknown as ModelEgressScope;
        case "empty":
          return {} as unknown as ModelEgressScope;
        case "no_company":
          return { source: "gemini" } as unknown as ModelEgressScope;
      }
    },
    privateSource: (company) => PRIVATE[company.label],
    credentialOf: (company, rowId) => {
      // The suite names rows by the world's keys (`azure`) and by their ids (`azure-openai`).
      const row = (rows as Record<string, ModelEgressRow>)[rowId] ?? rowsById.get(rowId)!;
      return isToken(row) ? tokenOf(company, row.id) : keyOf(company, row.id);
    },
    keysOf: (company) => [...rowsList.map((row) => (isToken(row) ? tokenOf(company, row.id) : keyOf(company, row.id))), keyOf(company, PRIVATE[company.label])],
    provider: { get calls() { return provider.calls; }, script: (...behaviours) => provider.script(...behaviours), reset: () => provider.reset() },
    meterOf: async (company) => (table.get(productAiMeterKeys.company(company.orgId, meterMonthOf(WORLD_NOW)))?.spentMicros as number | undefined) ?? 0,
    setCap: async (company, micros) => {
      for (const [id, source] of sources) if (id.startsWith(`${company.orgId}|`)) sources.set(id, { ...source, caps: { ...source.caps, taskMicros: micros, projectMonthMicros: micros } });
    },
    logs: () => [...logs, ...adapterLogs],
    table, secrets, deps, payloads, invokes: () => invokeCount, warnings, sources, capability, keyPair, mints,
    setTransport: (next) => { transport = next; },
  };
  const kit = modelEgressIsolation(world);
  world.isolation = {
    ...kit,
    // The function's company resolver is its State read of the operation (readScope). Broken, it must refuse (not_found, no model call) and say nothing of a company: a refusal is turned into a rejection here.
    failClosed: [{
      name: "the function's operation read throws or answers nothing",
      prepare: async () => undefined,
      attempt: async (mode) => {
        const broken: ProductModelEgressDependencies = { ...deps, readScope: async () => { if (mode === "throws") throw new Error("the operation read failed"); return undefined; } };
        const row = rows.gemini;
        const calls = provider.calls.length;
        const frame = { row: row.id, method: "POST", path: "/v1beta/models/fixture-small:generateContent", query: "", headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify({ contents: [{ parts: [{ text: COMPANY_A.canary }] }] })).toString("base64") };
        const answer = await collectHandler(broken, { v: 1, op: "forward", capability: await capability(COMPANY_A, row.id), frame });
        if (provider.calls.length !== calls) return { leaked: "a model call was made" };
        if (answer.settle?.refusal === "not_found" && answer.status === 404) throw new Error(`refused: ${answer.body}`);
        return answer;
      },
    }],
  };
  return world;
}

/** The function alone (no adapter, no wire), for tests that drive it directly. */
export async function collectHandler(deps: ProductModelEgressDependencies, input: unknown): Promise<{ status?: number; body: string; headers: ReadonlyArray<readonly [string, string]>; settle?: Record<string, unknown> }> {
  let status: number | undefined;
  let headers: ReadonlyArray<readonly [string, string]> = [];
  const chunks: Uint8Array[] = [];
  let settle: Record<string, unknown> | undefined;
  for await (const event of handleProductModelEgress(deps, input)) {
    if (event.kind === "head") { status = event.status; headers = event.headers; }
    else if (event.kind === "chunk") chunks.push(event.bytes);
    else settle = { ...event };
  }
  return { ...(status === undefined ? {} : { status }), headers, body: Buffer.concat(chunks).toString("utf8"), ...(settle === undefined ? {} : { settle }) };
}
