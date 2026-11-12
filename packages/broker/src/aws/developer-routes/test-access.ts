// Customer test AWS account, lane TA2 (customer-test-account.md section 1): the connect API's routes. The logic is `test-access/connect.ts`; this file only reads the request. Behind `ta`: with it off, or where the install has not given
// the routes their dependencies (`deps.testAccess`: the store, the template and topics, the AWS port; none of it is wired by TA2), every path here is not found, as any unknown path. A browser route family: a token (an API or CLI token) is refused.
//   POST   /v1/app/test-access/connections                       { projectId, region }  "Connect in AWS": the link (the only response that ever holds the connect token), the connection
//   GET    /v1/app/test-access/connections                       the company's connections
//   GET    /v1/app/test-access/connections/{id}                  the live state (Screen 3 reads it every few seconds)
//   POST   /v1/app/test-access/connections/{id}/account-id       { accountId }  the polling fallback
//   POST   /v1/app/test-access/connections/{id}/confirm          { accountId }  "yes, this is my account": the id the admin was shown; then the test runs
//   POST   /v1/app/test-access/connections/{id}/test             reruns the checks
//   POST   /v1/app/test-access/connections/{id}/not-production   {}  the tick for an alias that says production
//   POST   /v1/app/test-access/connections/{id}/suspend          {}
//   DELETE /v1/app/test-access/connections/{id}                  disconnect
// What a request never decides: the organization and the developer (the session's), the role (read live), the sign-in time (the stored session's), the external id, the role to assume, the Region of an existing connection.
import { z } from "zod";
import { agentXError } from "@rovara-code/contracts";
import { acknowledgeNotProduction, confirmConnection, disconnectConnection, getConnection, listConnections, startConnection, submitAccountId, suspendConnection, testConnection, type ConnectCaller } from "../../test-access/connect.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_ACCESS_PATH = /^\/v1\/app\/test-access\/connections(?:\/(conn_[0-9a-z]{20})(?:\/(account-id|confirm|test|not-production|suspend))?)?$/u;
export const TEST_ACCESS_BROWSER_MESSAGE = "Use a live browser session to connect an AWS account.";
export const isTestAccessPath = (pathname: string): boolean => /^\/v1\/app\/test-access\//u.test(pathname);
const BODY_MAX_CHARS = 2_048;

const StartBody = z.object({ projectId: z.string().min(1).max(63), region: z.string().min(1).max(32) }).strict();
const AccountBody = z.object({ accountId: z.string().min(1).max(32) }).strict();
const EmptyBody = z.object({}).strict();

function bodyOf<T extends z.ZodType>(request: AdaptedHttpRequest, schema: T): z.infer<T> {
  const text = request.body ?? "";
  if (text.length > BODY_MAX_CHARS) throw agentXError("CONFIG_INVALID", "The request is too large.");
  let json: unknown;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
  const parsed = schema.safeParse(json);
  // The answer names no field and echoes no value.
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The request is not valid.");
  return parsed.data;
}

export async function routeTestAccess(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | object | undefined> {
  const connect = deps.testAccess;
  if (connect === undefined || !connect.enabled()) return undefined;
  const match = TEST_ACCESS_PATH.exec(url.pathname);
  if (match === null) return undefined;
  const id = match[1];
  const action = match[2];
  const method = request.method;
  const known = id === undefined ? method === "POST" || method === "GET" : action === undefined ? method === "GET" || method === "DELETE" : method === "POST";
  if (!known) return undefined;
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", TEST_ACCESS_BROWSER_MESSAGE);
  const who: ConnectCaller = { orgId: caller.orgId, developerId: caller.developerId, sessionId: caller.sessionId };
  if (id === undefined) {
    if (method === "GET") return { connections: await listConnections(connect, who) };
    const body = bodyOf(request, StartBody);
    return new StatusReply(201, await startConnection(connect, who, body));
  }
  if (action === undefined) return method === "GET" ? { connection: await getConnection(connect, who, id) } : { connection: await disconnectConnection(connect, who, id) };
  switch (action) {
    case "account-id": return { connection: await submitAccountId(connect, who, id, bodyOf(request, AccountBody)) };
    case "confirm": return { connection: await confirmConnection(connect, who, id, bodyOf(request, AccountBody)) };
    case "test": bodyOf(request, EmptyBody); return { connection: await testConnection(connect, who, id) };
    case "not-production": bodyOf(request, EmptyBody); return { connection: await acknowledgeNotProduction(connect, who, id) };
    default: bodyOf(request, EmptyBody); return { connection: await suspendConnection(connect, who, id) };
  }
}
