// Customer test AWS account, lane TA2: the connect routes: what is routed, to whom, and that a request never decides the organization or the identity.
import { describe, expect, it } from "vitest";
import { routeTestAccess } from "../../packages/broker/src/aws/developer-routes/test-access.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import { ADMIN, ORG, PROJECT, REGION, tokenOfLink, world, type Fixture } from "../support/test-access-fixtures.js";

const callerOf = (over: Partial<DeveloperCaller> = {}): DeveloperCaller => ({ developerId: ADMIN, sessionId: "session-admin", amr: "email_code", name: "A", orgId: ORG, orgRole: "owner", browserSession: true, ...over } as DeveloperCaller);
const call = (w: Fixture | undefined, method: string, path: string, body?: unknown, caller = callerOf()) =>
  routeTestAccess({ testAccess: w?.connectDeps } as unknown as DeveloperRouteDependencies, caller, { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, new URL(`https://x${path}`));
const tokenCaller = (): DeveloperCaller => { const { browserSession: _unused, ...rest } = callerOf(); void _unused; return rest; };
const BASE = "/v1/app/test-access/connections";
const codeOf = async (run: Promise<unknown>): Promise<string | undefined> => ((await run.then(() => undefined, (error: unknown) => error)) as { code?: string } | undefined)?.code;

describe("the routes", () => {
  it("do not exist without their dependencies or with the ta switch off, and unknown paths and methods are not routed", async () => {
    const w = world();
    expect(await call(undefined, "POST", BASE, { projectId: PROJECT, region: REGION })).toBeUndefined();
    w.enabled.value = false;
    expect(await call(w, "POST", BASE, { projectId: PROJECT, region: REGION })).toBeUndefined();
    w.enabled.value = true;
    for (const [method, path] of [["PUT", BASE], ["GET", `${BASE}/nope`], ["POST", `${BASE}/conn_aaaaaaaaaaaaaaaaaaaa`], ["GET", `${BASE}/conn_aaaaaaaaaaaaaaaaaaaa/confirm`], ["POST", `${BASE}/conn_aaaaaaaaaaaaaaaaaaaa/other`], ["GET", "/v1/app/test-access/other"], ["POST", `${BASE}/conn_AAAAAAAAAAAAAAAAAAAA`]] as const) {
      expect(await call(w, method, path, {}), `${method} ${path}`).toBeUndefined();
    }
  });

  it("refuse a token or any caller that is not a live browser session", async () => {
    const w = world();
    expect(await codeOf(call(w, "POST", BASE, { projectId: PROJECT, region: REGION }, tokenCaller()))).toBe("FORBIDDEN");
    expect(await codeOf(call(w, "GET", BASE, undefined, tokenCaller()))).toBe("FORBIDDEN");
    expect(w.store.connections.size).toBe(0);
  });

  it("start, read, type the account id, and disconnect, each as the session's own organization", async () => {
    const w = world();
    const started = (await call(w, "POST", BASE, { projectId: PROJECT, region: REGION })) as StatusReply;
    expect(started).toBeInstanceOf(StatusReply);
    expect(started.statusCode).toBe(201);
    const { connection, link } = started.body as { connection: { connectionId: string }; link: string };
    expect(tokenOfLink(link)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const id = connection.connectionId;
    expect(((await call(w, "GET", BASE)) as { connections: unknown[] }).connections).toHaveLength(1);
    const read = (await call(w, "GET", `${BASE}/${id}`)) as { connection: { status: string } };
    expect(read.connection.status).toBe("awaiting");
    expect(JSON.stringify(read)).not.toContain(tokenOfLink(link));
    const polling = (await call(w, "POST", `${BASE}/${id}/account-id`, { accountId: "222233334444" })) as { connection: { status: string } };
    expect(polling.connection.status).toBe("polling");
    expect(((await call(w, "DELETE", `${BASE}/${id}`)) as { connection: { status: string } }).connection.status).toBe("disconnected");
  });

  it("read the organization from the session, never the request: an organization in the body is refused, and another organization's id is not found", async () => {
    const w = world();
    expect(await codeOf(call(w, "POST", BASE, { projectId: PROJECT, region: REGION, orgId: "org_zzzzzzzzzzzzzzzzzzzz" }))).toBe("CONFIG_INVALID");
    const started = (await call(w, "POST", BASE, { projectId: PROJECT, region: REGION })) as StatusReply;
    const id = (started.body as { connection: { connectionId: string } }).connection.connectionId;
    w.admins.add("c".repeat(64));
    const other = callerOf({ developerId: "c".repeat(64), orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    expect(await codeOf(call(w, "GET", `${BASE}/${id}`, undefined, other))).toBe("NOT_FOUND");
    expect(await codeOf(call(w, "DELETE", `${BASE}/${id}`, undefined, other))).toBe("NOT_FOUND");
    expect(await codeOf(call(w, "POST", `${BASE}/${id}/confirm`, { accountId: "222233334444" }, other))).toBe("REAUTH_REQUIRED");
  });

  it("refuse a body that is not JSON, has unknown fields, is huge, or is the wrong shape, without echoing it", async () => {
    const w = world();
    const id = "conn_aaaaaaaaaaaaaaaaaaaa";
    for (const body of ["{not json", { projectId: PROJECT }, { projectId: PROJECT, region: REGION, extra: 1 }, { projectId: 5, region: REGION }, { projectId: PROJECT, region: "x".repeat(5_000) }, "[]", "null"]) {
      const error = await (call(w, "POST", BASE, body)).then(() => undefined, (caught: Error & { code?: string }) => caught);
      expect(error?.code, JSON.stringify(body).slice(0, 40)).toBe("CONFIG_INVALID");
      expect(error?.message).not.toContain("extra");
    }
    for (const action of ["test", "not-production", "suspend"]) expect(await codeOf(call(w, "POST", `${BASE}/${id}/${action}`, { x: 1 })), action).toBe("CONFIG_INVALID");
    for (const action of ["account-id", "confirm"]) {
      expect(await codeOf(call(w, "POST", `${BASE}/${id}/${action}`, {})), action).toBe("CONFIG_INVALID");
      expect(await codeOf(call(w, "POST", `${BASE}/${id}/${action}`, { accountId: "222233334444", roleArn: "arn:aws:iam::222233334444:role/x" })), action).toBe("CONFIG_INVALID");
    }
    expect(w.store.connections.size).toBe(0);
  });
});
