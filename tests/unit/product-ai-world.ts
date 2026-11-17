// A Cloud handler over a fake Code (access checks with step-up claims, project member changes) and the gateway's real write-only
// product key store, for the product AI, Vertex connect, learning AI key and approval-withdrawal route tests.
import { randomBytes, randomUUID } from "node:crypto";
import { CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, defaultCompanySettings, type BedrockBackend, type CloudRequest, type ProductAiStore } from "../../packages/cloud-server/src/index.js";
import { InMemoryProductKeyTable, ProductKeyStore, type BedrockCheck, type TableWrite, type VertexCheck } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, localProductKeyService, ProductKeySealer } from "../../packages/model-gateway/src/product-seal.js";

export const CODE = "https://code.example.test";
export const ISS = `${CODE}/v1/auth`;
export const ORIGIN = "https://cloud.example.test";
export const A = "org_aaaaaaaaaaaaaaaaaaaa";
export const B = "org_bbbbbbbbbbbbbbbbbbbb";
export const START = Date.parse("2026-11-15T12:00:00.000Z");

export interface Person { developerId: string; name: string; administrator: boolean; companyId: string; projects: Array<{ name: string; access: string }> }
export const PEOPLE: Record<string, Person> = {
  pam: { developerId: "a".repeat(64), name: "Pam", administrator: false, companyId: A, projects: [{ name: "web", access: "administrator" }] },
  cal: { developerId: "c".repeat(64), name: "Cal", administrator: false, companyId: A, projects: [{ name: "web", access: "developer" }] },
  ada: { developerId: "d".repeat(64), name: "Ada", administrator: true, companyId: A, projects: [] },
  bob: { developerId: "b".repeat(64), name: "Bob", administrator: false, companyId: B, projects: [{ name: "web", access: "administrator" }] },
  bea: { developerId: "e".repeat(64), name: "Bea", administrator: true, companyId: B, projects: [] },
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
export type Body = Record<string, unknown> & { error?: { code: string; message: string } };
export const write = (expectedRevision: number, more: Record<string, unknown> = {}) => ({ requestId: randomUUID(), expectedRevision, ...more });

export interface WorldOptions { vertexCheck?: VertexCheck; bedrockCheck?: BedrockCheck; bedrock?: BedrockBackend; beforeCommit?: (writes: readonly TableWrite[]) => boolean | void; company?: boolean; /** DEC 254t: the install's switched-on AI source kinds (company backend). */ aiSourceKinds?: ReadonlySet<string>; /** Code's access check takes this long (the clock moves while it runs). */ accessMs?: number; /** Code's answer to a member change (default 200), and what happens while Code makes it. */ memberStatus?: number; duringMemberChange?: () => Promise<void> }

export function world(options: WorldOptions = {}) {
  const clock = { at: START }; let tokens = 0;
  const nowS = () => Math.floor(clock.at / 1000);
  const byToken = new Map<string, Person>();
  const codeCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const person = byToken.get(((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, ""));
    if (person === undefined) return new Response("{}", { status: 401 });
    if (url.pathname === "/v1/dev/access") clock.at += options.accessMs ?? 0;
    if (url.pathname === "/v1/dev/access") return new Response(JSON.stringify({ developerId: person.developerId, displayName: person.name, administrator: person.administrator, companyId: person.companyId, projects: person.projects, notices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const member = /^\/v1\/dev\/client\/projects\/([^/]+)\/members\/([^/]+)$/u.exec(url.pathname);
    if (member !== null) {
      codeCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      await options.duringMemberChange?.();
      if (options.memberStatus !== undefined && options.memberStatus !== 200) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "no" } }), { status: options.memberStatus, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ developerId: decodeURIComponent(member[2]!), outcome: "revoked" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock.at, environment: {} });
  const table = new InMemoryProductKeyTable(options.beforeCommit);
  const store = new ProductKeyStore({ table, sealer: new ProductKeySealer(localProductKeyService(randomBytes(32))), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => clock.at, ...(options.vertexCheck === undefined ? {} : { vertexCheck: options.vertexCheck }), ...(options.bedrockCheck === undefined ? {} : { bedrockCheck: options.bedrockCheck }) });
  const typed: ProductAiStore = store;
  const audit = new LocalCloudAuditStore(undefined, {});
  const companies = new LocalCompanyStore();
  const logs: string[] = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN,
    now: () => new Date(clock.at), log: (event) => { logs.push(JSON.stringify(event)); }, audit, productAi: { store: typed, issuer: ISS, ...(options.bedrock === undefined ? {} : { bedrock: options.bedrock }) },
    ...(options.company === true ? { company: { store: companies, log: (event: Record<string, unknown>) => { logs.push(JSON.stringify(event)); }, ...(options.aiSourceKinds === undefined ? {} : { aiSourceKinds: options.aiSourceKinds }) } } : {}),
  });
  const signIn = async (who: string, stepUpAge?: number) => {
    const person = PEOPLE[who]!; tokens += 1;
    const token = `${b64({ alg: "RS256", typ: "JWT", kid: "code" })}.${b64({ sub: person.developerId, iat: nowS(), exp: nowS() + 3600, jti: String(tokens), ...(stepUpAge === undefined ? {} : { step_up_at: nowS() - stepUpAge, step_up_amr: "passkey" }) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.developerId, displayName: person.name, administrator: person.administrator, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(clock.at).toISOString() });
    return cookie;
  };
  const call = async (cookie: string, method: string, path: string, body?: unknown, csrf = `csrf-${cookie}`) => {
    const request: CloudRequest = { method, path: `/v1/web${path}`, query: new URLSearchParams(), headers: { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answer = (await handler(request))!;
    return { status: answer.status, body: JSON.parse(answer.body) as Body, raw: answer.body };
  };
  const setCompanySettings = async (companyId: string, change: (settings: ReturnType<typeof defaultCompanySettings>) => void) => {
    const settings = defaultCompanySettings(); change(settings);
    const current = await companies.settings(companyId);
    await companies.putSettings(companyId, settings, current?.version ?? 0, "a".repeat(64), new Date(clock.at).toISOString());
  };
  return { store, table, audit, companies, logs, codeCalls, clock, signIn, call, setCompanySettings, advance: (ms: number) => { clock.at += ms; } };
}
