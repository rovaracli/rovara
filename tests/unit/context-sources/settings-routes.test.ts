import { describe, expect, it } from "vitest";
import { routeContextSources, schemaTakesAddress, type ContextSourceRouteDependencies } from "../../../packages/broker/src/context-sources/settings-routes.js";
import { dynamoContextSourceStore } from "../../../packages/broker/src/context-sources/store.js";
import { StatusReply } from "../../../packages/broker/src/aws/status-reply.js";
import type { AgentCaller } from "../../../packages/broker/src/agents/access.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { GET_TOOL, NOW, ORG, PLAIN_TOOL, SEARCH_TOOL, environment, source } from "./fixtures.js";

const caller = (orgRole = "admin", developerId = "dev1"): AgentCaller => ({ orgId: ORG, developerId, orgRole } as AgentCaller);

function world() {
  const table = new FakeDynamoDb();
  const roles: string[] = [];
  const deps: ContextSourceRouteDependencies = {
    store: dynamoContextSourceStore({ documentClient: table, tableName: "state", now: () => NOW }), env: environment({ tools: [SEARCH_TOOL, GET_TOOL, PLAIN_TOOL] }), now: () => NOW,
    requireProjectRole: async (_caller, project) => { roles.push(project); },
    table: { documentClient: table, tableName: "state" },
  };
  const send = (method: string, path: string, body?: unknown, who = caller()) =>
    routeContextSources(deps, who, { method, path, headers: {}, requestId: "r1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(`https://x${path}`));
  return { send, roles };
}

describe("the Sources settings routes", () => {
  it("turns a member away before anything is read", async () => {
    const { send, roles } = world();
    await expect(send("GET", "/v1/app/projects/proj/context-sources", undefined, caller("member"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(roles).toEqual([]);
  });
  it("lists a server's tools with what Rovara checks on each", async () => {
    const { send } = world();
    const answer = await send("POST", "/v1/app/projects/proj/context-sources/discover", { server: { kind: "connection", connectionId: "con_aaaaaaaaaaaaaaaaaaaa" } }) as { tools: Array<Record<string, unknown>> };
    expect(answer.tools.map((tool) => [tool.name, tool.annotation])).toEqual([["search_tickets", "read_only"], ["get_ticket", "read_only"], ["lookup_page", "unannotated"]]);
    expect(answer.tools[0]!.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("proposes (202), then applies only on confirmation", async () => {
    const { send } = world();
    const proposed = await send("POST", "/v1/app/projects/proj/context-sources/changes", { kind: "set", source: source() });
    expect(proposed).toBeInstanceOf(StatusReply);
    const { changeId } = (proposed as StatusReply).body as { changeId: string };
    expect(((await send("GET", "/v1/app/projects/proj/context-sources")) as { document: { sources: unknown[] } }).document.sources).toEqual([]);
    await send("POST", `/v1/app/projects/proj/context-sources/changes/${changeId}/confirm`);
    expect(((await send("GET", "/v1/app/projects/proj/context-sources")) as { document: { sources: unknown[] } }).document.sources).toHaveLength(1);
  });
  it("does not echo a field it does not know", async () => {
    const { send } = world();
    await expect(send("POST", "/v1/app/projects/proj/context-sources/changes", { kind: "remove", sourceId: "x", token: "sk-live-abc" })).rejects.toSatisfy((error: Error) => !error.message.includes("sk-live-abc"));
  });
});

describe("tools that take an address", () => {
  it("are recognised by a uri format or an address-like argument name", () => {
    expect(schemaTakesAddress({ properties: { target_url: { type: "string" } } })).toBe(true);
    expect(schemaTakesAddress({ properties: { link: { type: "string", format: "uri" } } })).toBe(true);
    expect(schemaTakesAddress({ properties: { query: { type: "string" } } })).toBe(false);
  });
});
