// N9 (INTG2): the route's glue: the exchange reads the operation, the workspace and the project revision the workspace is pinned to from the State table, and decides from those alone.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { agentXError, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { exchangeRegistryCredential, registriesPrepareOf } from "../../packages/broker/src/aws/broker/registry-credentials.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const fakeToken = (seed: string): string => `eyJ${Buffer.from(`${seed}-token-material-${seed.repeat(24)}`).toString("base64url")}.${Buffer.from(seed.repeat(30)).toString("base64url")}`;
const WS = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const ORG = "org_abcdefghijklmnopqrst" as OrgId;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const BINDING = "acme:123456789012:us-west-2:abcdefghijklmnopqrst:shared";
const CA = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" } as const;
const DEFINITION = { name: "payments", revision: 3, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x", registries: [CA], network: { allowedDomains: ["*.d.codeartifact.us-west-2.amazonaws.com"] } };

function world(over: { workspaceStatus?: string; operationKind?: string; active?: string | null; workspaceOrg?: OrgId } = {}) {
  const items = new Map<string, unknown>();
  const put = (key: { pk: string; sk: string }, item: unknown) => items.set(`${key.pk}|${key.sk}`, item);
  put({ pk: `WORKSPACE#${WS}`, sk: "META" }, { id: WS, ownerKey: "owner-key-0123456789", orgId: over.workspaceOrg ?? ORG, projectName: "payments", projectRevision: 3, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: over.workspaceStatus ?? "PREPARING", activeOperationId: over.active === undefined ? OP : over.active, fence: 1, createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" });
  put({ pk: `WORKSPACE#${WS}`, sk: `OPERATION#${OP}` }, { id: OP, workspaceId: WS, kind: over.operationKind ?? "prepare", status: "RUNNING" });
  put(projectRevisionKey(over.workspaceOrg ?? ORG, "payments", 3), { definition: DEFINITION });
  const reads: string[] = [];
  const token = fakeToken("g");
  const grants = new RepositoryGrantService(Buffer.alloc(32, 5), async () => ({}));
  const dependencies = {
    tableName: "state",
    documentClient: { send: async (command: unknown) => { if (!(command instanceof GetCommand)) throw new Error("unexpected command"); const key = command.input.Key as { pk: string; sk: string }; reads.push(`${key.pk}|${key.sk}`); return { Item: items.get(`${key.pk}|${key.sk}`) }; } },
    repositoryGrants: grants,
    editionPolicy: { edition: "enterprise" },
    registryTokens: { codeArtifact: async () => ({ token, expiresAt: new Date(Date.now() + 3_600_000) }) },
  } as unknown as AwsBrokerDependencies;
  const grant = grants.issue({ ownerKey: "o", projectName: "payments", workspaceId: WS, operationId: OP, repositories: [] });
  const request = (body: unknown, headerGrant: string | null = grant) => ({ method: "POST", path: "/", headers: headerGrant === null ? {} : { "x-agentx-repository-grant": headerGrant }, body: JSON.stringify(body), requestId: "r" }) as never;
  return { dependencies, request, token, reads };
}

describe("the registry credential route", () => {
  it("is off unless the install switch says so, even when the tokens exist", async () => {
    const { dependencies, request } = world();
    await expect(exchangeRegistryCredential(dependencies, request({ registry: "internal-npm" }), WS, OP)).rejects.toThrow(/not switched on/);
  });

  describe("with the switch on", () => {
    const withSwitch = async <T>(run: () => Promise<T>): Promise<T> => {
      process.env.PROJECT_REGISTRIES_ENABLED = "1";
      process.env.PROJECT_REGISTRY_DOMAINS = BINDING;
      try { return await run(); } finally { delete process.env.PROJECT_REGISTRIES_ENABLED; delete process.env.PROJECT_REGISTRY_DOMAINS; }
    };

    it("gives the running preparation the token of the registry its pinned project revision names", async () => {
      const { dependencies, request, token } = world();
      const answer = await withSwitch(() => exchangeRegistryCredential(dependencies, request({ registry: "internal-npm" }), WS, OP));
      expect(answer.credential.token).toBe(token);
      expect(answer.credential.username).toBe("aws");
    });

    it("gives nothing for a task's operation, a ready workspace or another registry name; nothing is minted", async () => {
      for (const over of [{ operationKind: "task" }, { workspaceStatus: "READY", active: null }]) {
        const { dependencies, request } = world(over);
        await expect(withSwitch(() => exchangeRegistryCredential(dependencies, request({ registry: "internal-npm" }), WS, OP))).rejects.toThrow(/running preparation only/);
      }
      const { dependencies, request } = world();
      await expect(withSwitch(() => exchangeRegistryCredential(dependencies, request({ registry: "other" }), WS, OP))).rejects.toThrow(/does not cover/);
      await expect(withSwitch(() => exchangeRegistryCredential(dependencies, request({ registry: "internal-npm" }, null), WS, OP))).rejects.toThrow(/grant is required/);
      await expect(withSwitch(() => exchangeRegistryCredential(dependencies, request("not an object"), WS, OP))).rejects.toThrow();
    });

    it("another org's workspace naming this org's domain gets no token through the route either", async () => {
      const { dependencies, request } = world({ workspaceOrg: OTHER_ORG });
      await expect(withSwitch(() => exchangeRegistryCredential(dependencies, request({ registry: "internal-npm" }), WS, OP))).rejects.toThrow(/not set up for this organization/);
    });

    it("no AWS-shaped error escapes: a failing minter answers with the fixed sentence", async () => {
      const { dependencies, request } = world();
      const failing = { ...dependencies, registryTokens: { codeArtifact: async () => { throw agentXError("RUNTIME_UNAVAILABLE", `AccessDenied ${fakeToken("leak")}`); } } } as unknown as AwsBrokerDependencies;
      const failure = await withSwitch(() => exchangeRegistryCredential(failing, request({ registry: "internal-npm" }), WS, OP)).then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain('Rovara could not get a token for the package registry "internal-npm"');
      expect(failure?.message).not.toContain("AccessDenied");
    });
  });
});

describe("the prepare payload's registries", () => {
  it("comes from the project record, only with the switch on, and never for a read-only run", () => {
    const { dependencies } = world();
    const project = { definition: DEFINITION } as never;
    expect(registriesPrepareOf(dependencies, { definition: { ...DEFINITION, registries: undefined } } as never, { orgId: ORG })).toEqual({});
    expect(() => registriesPrepareOf(dependencies, project, { orgId: ORG })).toThrow(/not switched on/);
    process.env.PROJECT_REGISTRIES_ENABLED = "1";
    process.env.PROJECT_REGISTRY_DOMAINS = BINDING;
    try {
      expect(registriesPrepareOf(dependencies, project, { orgId: ORG }).registries).toEqual([{ name: "internal-npm", kind: "codeartifact", format: "npm", url: "https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/" }]);
      expect(registriesPrepareOf(dependencies, project, { readOnly: true, orgId: ORG })).toEqual({});
      // Another org's project naming this org's domain cannot start.
      expect(() => registriesPrepareOf(dependencies, project, { orgId: OTHER_ORG })).toThrow(/not set up for this organization/);
    } finally { delete process.env.PROJECT_REGISTRIES_ENABLED; delete process.env.PROJECT_REGISTRY_DOMAINS; }
  });
});
