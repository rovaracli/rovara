// ME-13 (wire lane C): the broker's own dependency builders hand the lane E routes to a real handler. The routes answer only where the install has a connection secrets role, the Sources settings
// in both editions, the org's MCP servers in Enterprise only, and package-run servers stay off until the operator turns them on with a host.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "../../packages/contracts/src/org-node.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";

const ENV = "staging";
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("3", "Max"); // member
const orgResolver: OrgResolver = async () => TEST_ORG;

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => { vi.unstubAllEnvs(); });

async function setup(options: { connectionSecrets?: boolean } = {}) {
  const fake = new FakeOrgSecrets({ env: ENV, now: Date.now });
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: Date.now });
  const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false,
    brokerExtra: {
      agents: { projectMembers: new FakeProjectMembers() },
      ...(options.connectionSecrets === false ? {} : { orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now } }),
    },
  });
  holder.db = h.db;
  for (const [who, role] of [[DANA, "admin"], [MAX, "member"]] as Array<[Developer, OrgRole]>) {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  }
  const call = async (who: Developer, method: string, path: string) => h.dev(who, method, path, undefined) as Promise<{ status: number; body: { error?: { code: string; message: string }; servers?: unknown[]; stdioAvailable?: boolean } }>;
  return { h, call };
}

const SOURCES = "/v1/app/projects/payments/context-sources";
const SERVERS = "/v1/app/org/mcp-servers";
const NOT_SET_UP = /not set up in this deployment/u;

describe("the lane E routes in a real handler", () => {
  it("answers the org's MCP servers in Enterprise, to an admin only, with package-run servers off", async () => {
    vi.stubEnv("ROVARA_EDITION", "enterprise");
    const { call } = await setup();
    const listed = await call(DANA, "GET", SERVERS);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toMatchObject({ servers: [], stdioAvailable: false });
    expect((await call(MAX, "GET", SERVERS)).status).toBe(403);
  });
  it("turns package-run servers on only with the switch and an https host", async () => {
    vi.stubEnv("ROVARA_EDITION", "enterprise");
    vi.stubEnv("ROVARA_STDIO_MCP_SERVERS", "1");
    vi.stubEnv("MCP_HOST_URL", "https://mcp-host.example.net");
    vi.stubEnv("MCP_HOST_TOKEN", "t".repeat(40));
    expect((await (await setup()).call(DANA, "GET", SERVERS)).body.stdioAvailable).toBe(true);
  });
  it("refuses to start a handler whose MCP settings are wrong, naming the setting", async () => {
    vi.stubEnv("ROVARA_EDITION", "enterprise");
    vi.stubEnv("ROVARA_PRIVATE_MCP_CIDRS", "8.8.8.0/24");
    await expect(setup()).rejects.toThrow(/ROVARA_PRIVATE_MCP_CIDRS/u);
    vi.stubEnv("ROVARA_PRIVATE_MCP_CIDRS", "");
    vi.stubEnv("MCP_HOST_URL", "http://mcp-host.example.net");
    vi.stubEnv("MCP_HOST_TOKEN", "t".repeat(40));
    await expect(setup()).rejects.toThrow(/https/u);
  });
  it("has no MCP servers routes in Public, but has the Sources settings", async () => {
    vi.stubEnv("ROVARA_EDITION", "public");
    const { call } = await setup();
    const servers = await call(DANA, "GET", SERVERS);
    expect(servers.status).toBe(404);
    expect(servers.body.error?.message).toMatch(NOT_SET_UP);
    // the Sources settings are there: the answer is about the project, not about the deployment
    const sources = await call(DANA, "GET", SOURCES);
    expect(sources.body.error?.message ?? "").not.toMatch(NOT_SET_UP);
  });
  it("is inert where the install has no connection secrets role: both routes say they are not set up", async () => {
    vi.stubEnv("ROVARA_EDITION", "enterprise");
    const { call } = await setup({ connectionSecrets: false });
    for (const path of [SERVERS, SOURCES]) {
      const reply = await call(DANA, "GET", path);
      expect(reply.status, path).toBe(404);
      expect(reply.body.error?.message, path).toMatch(NOT_SET_UP);
    }
  });
});
