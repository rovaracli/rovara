// Browser fixture: real member/identity handlers and OrgStore over a bounded read-only in-memory table.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, orgMetaKey } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { OrgStore } from "../../../packages/broker/src/org/store.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../../packages/broker/src/aws/developer-routes.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER } from "../../web/support/fixtures.js";
export async function adminDirectoryRead(base: DeveloperRouteDependencies, caller: DeveloperCaller, path: string, memberName = "Maya") {
 const rows: Array<Record<string, unknown>> = [];
 const joinedAt = "2026-10-01T00:00:00.000Z";
 for (const [org, id, name, role] of [[FIXTURE_ORG, FIXTURE_DEVELOPER, "Priya", caller.orgRole], [FIXTURE_ORG, "b".repeat(64), memberName, "member"], ["org_bbbbbbbbbbbbbbbbbbbb", "c".repeat(64), "Other company person", "owner"]] as const) {
  rows.push({ ...orgMemberKey(org, id), orgId: org, developerId: id, role, joinedAt });
  rows.push({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name, provider: "cloud" });
 }
 rows.push({ ...orgMetaKey(FIXTURE_ORG), orgId: FIXTURE_ORG, name: "Acme", plan: "team", createdBy: FIXTURE_DEVELOPER });
 const documentClient = { async send(command: unknown): Promise<unknown> {
  if (command instanceof GetCommand) return { Item: rows.find(row => row.pk === command.input.Key?.pk && row.sk === command.input.Key?.sk) };
  if (command instanceof QueryCommand) {
   const values = command.input.ExpressionAttributeValues ?? {};
   const pk: unknown = values[":pk"], prefix: unknown = values[":prefix"] ?? "";
   return { Items: rows.filter(row => row.pk === pk && String(row.sk).startsWith(String(prefix))) };
  }
  throw new Error("Only read operations are supported by the admin fixture.");
 } };
 const deps = { ...base, documentClient, orgs: new OrgStore({ documentClient, tableName: "mock-state", now: Date.now }) };
 const url = new URL(path, base.developer.issuer);
 return routeDeveloperRequest(deps, { method: "GET", path, headers: {}, requestId: "admin-browser-read" }, url, { caller, csrf: appCsrfTokenFor(caller.sessionId) });
}
