// MEMBERSHIP-READ-FAILS-SAFE (Cloud half; was REMOVED-MEMBER-ANSWER; Code's half is tests/journeys/removed-member-answer.test.ts and tests/unit/removed-member-refresh.test.ts on the Code branch).
// Cloud's real handler and CodeClient over a pretend Code that answers EXACTLY as Code's own journeys recorded (briefs/arch-cleanup/REMOVED-MEMBER-ANSWER-FINDINGS.md has the table), and the answer then goes
// through the app's REAL api client and query cache (tests/web/served-read.test.ts' way), with the task's data already on screen:
//   removed member (membership stamped revoked): every read 401 AUTH_REQUIRED at Code's sign-in check, the access check 401, the refresh 400 invalid_grant;
//   a failed membership read in Code: a read 401 AUTH_REQUIRED (the sign-in check) or 401 UNAUTHENTICATED (the engine's own), a refresh 400 invalid_grant AND the session revoked, or the access check 5xx;
//   a person with no company (membership row absent): the access check 200 with no company, the refresh 200, every read 401 AUTH_REQUIRED.
// Rules held here: a removed member is signed out and no private data stays; a failure of Code's own store never signs a member out (Code answers 503 for it, and Cloud's own access check answering a 5xx after a
// second 401 is a retryable 503 too); a real 401 after the refresh still ends the sign-in. The 501 "This isn't available on this Rovara Code yet" answer to a persisting 401 (the engine's UNAUTHENTICATED, a person
// with no company) is NOT this lane's (T1a/T1b): it is characterized here, not changed.
import { z } from "zod";
import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession, type WorkSession } from "../../packages/cloud-server/src/index.js";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "../web/support/fake-host.js";
import type { ApiResponse } from "../../packages/ui/src/host.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const NOW = Date.UTC(2026, 10, 25, 12);
const ADA = "a".repeat(64);
const CLOUD_SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const TASK = "11111111-1111-4111-8111-111111111111";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const tokenOf = (name: string) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: name, iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600, jti: name })}.c2ln`;

/** What Code answers, as its own journeys recorded it (the words are Code's). */
const CODE_ANSWER = {
  signInRefusedAtFront: () => json(401, { error: { code: "AUTH_REQUIRED", message: "this access check needs a signed-in person's token for this service, or a confidential service's own credentials" } }),
  engineUnauthenticated: () => json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in again." } }),
  refreshRefused: () => json(400, { error: "invalid_grant", error_description: "your Rovara sign-in has ended; start signing in again" }),
  refreshRenewed: (n: number) => json(200, { access_token: tokenOf(`renewed-${String(n)}`), token_type: "Bearer", expires_in: 3600, refresh_token: `r-${String(n)}` }),
  refreshUnavailable: () => json(503, { error: "temporarily_unavailable", error_description: "try again in a moment" }),
  readOk: () => json(200, { events: [] }),
  accessOk: () => json(200, { developerId: ADA, displayName: "Ada", administrator: false, projects: [], notices: [] }),
  accessWithNoCompany: () => json(200, { developerId: ADA, displayName: "Ada", administrator: false, projects: [], notices: [] }),
  unavailable: () => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "AgentX could not reach AWS just now; try again in a moment" } }),
};
type Answer = () => Response;
/** What Code answers to each kind of call, in the order the calls arrive. A script that runs out repeats its last answer. */
interface Script { reads: Answer[]; refreshes: Answer[]; accesses: Answer[] }
const nth = (list: Answer[], n: number): Response => list[Math.min(n, list.length - 1)]!();

function setUp(script: Script) {
  const counts = { read: 0, refresh: 0, access: 0 };
  const trail: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/v1/auth/token") { trail.push("refresh"); return nth(script.refreshes, counts.refresh++); }
    if (url.pathname === "/v1/dev/access") { trail.push("access check"); return nth(script.accesses, counts.access++); }
    trail.push(`read ${url.pathname.replace(TASK, "<task>")}`);
    return nth(script.reads, counts.read++);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "", fetch: fetchImpl });
  const handler = createCloudHandler({ client, store, work, origin: ORIGIN, org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(NOW) });
  const record: WorkSession = { sessionId: CLOUD_SESSION, taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-25T10:00:00.000Z", revision: 1 };
  const cookieId = "cookie-ada";
  const headers = { cookie: `rovara_cloud_session=${cookieId}`, "x-rovara-csrf": "csrf", origin: ORIGIN };
  const start = async () => {
    await work.put({ ...record });
    const access: CodeSession["access"] = { developerId: ADA, displayName: "Ada", administrator: false, projects: [{ name: "payments", access: "developer" }], notices: [] };
    await store.create(cookieId, { accessToken: tokenOf("first"), refreshToken: "r-0", csrf: "csrf", signedInAt: new Date(NOW).toISOString(), access });
  };
  /** The task screen's read (the conversation's timeline), as the browser makes it. */
  const read = async (): Promise<ApiResponse> => {
    const request: CloudRequest = { method: "GET", path: `/v1/web/sessions/${CLOUD_SESSION}/events`, query: new URLSearchParams(), headers: { ...headers, "content-type": "application/json" } };
    const answered = (await handler(request))!;
    return { status: answered.status, body: JSON.parse(answered.body) as unknown };
  };
  return { start, read, trail, signedIn: async () => (await store.get(cookieId)) !== undefined };
}

const reader = z.object({}).passthrough();
const privateData = { details: "Private task details" };
/** The app's real api client and query cache with the task's data already on screen, then this read answered by `answer`. */
async function screenAfter(answer: ApiResponse) {
  const client = createQueryClient(), key = ["task", TASK, "screen"];
  client.setQueryData(key, privateData, { updatedAt: NOW - 60_000 });
  const cell = fakeHost(async () => answer);
  const api = createApiClient(cell.host);
  const observer = new QueryObserver(client, { queryKey: key, queryFn: () => api.get("/v1/web/sessions/x/events", reader, undefined, { retry: "never" }) });
  try {
    await observer.refetch();
    const result = observer.getCurrentResult();
    return { keptData: client.getQueryData(key) !== undefined, error: result.error as { status?: number; code?: string; message?: string } | null, sentToSignIn: cell.host.signIn as unknown as { mock: { calls: unknown[] } } };
  } finally { observer.destroy(); client.clear(); }
}
const NOT_ON_CODE = "This isn't available on this Rovara Code yet.";

describe("a member with a task screen open and Code's answers (as Code's own journeys recorded them)", () => {
  it("(control) a member's read is served", async () => {
    const w = setUp({ reads: [CODE_ANSWER.readOk], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [CODE_ANSWER.accessOk] });
    await w.start();
    expect((await w.read()).status).toBe(200);
  });

  it("(removed member) Code refuses the read at its sign-in check, the refresh and the access check: Cloud signs them out (401 AUTH_REQUIRED, the Cloud session deleted), the app is sent to sign in and no private data stays on screen", async () => {
    const w = setUp({ reads: [CODE_ANSWER.signInRefusedAtFront], refreshes: [CODE_ANSWER.refreshRefused], accesses: [CODE_ANSWER.signInRefusedAtFront] });
    await w.start();
    const answer = await w.read();
    expect([answer.status, (answer.body as { error: { code: string } }).error.code], `Code was asked: ${w.trail.join(" -> ")}`).toEqual([401, "AUTH_REQUIRED"]);
    expect(await w.signedIn()).toBe(false);
    const screen = await screenAfter(answer);
    expect(screen.keptData, "private data left on screen").toBe(false);
    expect(screen.sentToSignIn.mock.calls.length).toBe(1);
  });

  it("(one failed read, first call only) Code's sign-in check fails once, the refresh works, the retry is served: the member never notices", async () => {
    const w = setUp({ reads: [CODE_ANSWER.signInRefusedAtFront, CODE_ANSWER.readOk], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [CODE_ANSWER.accessOk] });
    await w.start();
    expect((await w.read()).status, `Code was asked: ${w.trail.join(" -> ")}`).toBe(200);
    expect(await w.signedIn()).toBe(true);
  });

  it("(Code after MEMBERSHIP-READ-FAILS-SAFE) a membership read that failed during the REFRESH is answered 503 by Code: Cloud keeps the sign-in, answers a retryable 503 and the screen keeps its data marked stale, with no sign-in redirect", async () => {
    const w = setUp({ reads: [CODE_ANSWER.signInRefusedAtFront], refreshes: [CODE_ANSWER.refreshUnavailable], accesses: [CODE_ANSWER.accessOk] });
    await w.start();
    const answer = await w.read();
    expect(answer.status, JSON.stringify(answer.body)).toBe(503);
    expect(await w.signedIn()).toBe(true);
    const screen = await screenAfter(answer);
    expect(screen.keptData).toBe(true);
    expect(screen.sentToSignIn.mock.calls.length).toBe(0);
  });

  it("the read is refused twice (the failed read lasts past the refresh) and Cloud's own access check then answers a 5xx: a retryable 503, the sign-in is kept, and the screen keeps its data marked stale (no sign-in redirect)", async () => {
    for (const status of [500, 502, 503, 429, 408]) {
      const w = setUp({ reads: [CODE_ANSWER.signInRefusedAtFront], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [() => json(status, { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } })] });
      await w.start();
      const answer = await w.read();
      expect({ status, answer: answer.status, signedInAtCloud: await w.signedIn() }, `Code was asked: ${w.trail.join(" -> ")}`).toEqual({ status, answer: 503, signedInAtCloud: true });
      expect((answer.body as { error: { code: string } }).error.code).toBe("RUNTIME_UNAVAILABLE");
      const screen = await screenAfter(answer);
      expect({ status, keptData: screen.keptData, sentToSignIn: screen.sentToSignIn.mock.calls.length }).toEqual({ status, keptData: true, sentToSignIn: 0 });
    }
  });

  it("a REAL 401 after the refresh still ends the sign-in: the read is refused twice and Code's access check itself answers 401 (and a 403 from it too): signed out, data wiped, sent to sign in", async () => {
    for (const status of [401, 403]) {
      const w = setUp({ reads: [CODE_ANSWER.signInRefusedAtFront], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [() => json(status, { error: { code: "AUTH_REQUIRED", message: "no" } })] });
      await w.start();
      const answer = await w.read();
      expect({ status, answer: answer.status, signedInAtCloud: await w.signedIn() }, `Code was asked: ${w.trail.join(" -> ")}`).toEqual({ status, answer: 401, signedInAtCloud: false });
      const screen = await screenAfter(answer);
      expect({ keptData: screen.keptData, sentToSignIn: screen.sentToSignIn.mock.calls.length }).toEqual({ keptData: false, sentToSignIn: 1 });
    }
  });

  it.each([
    ["the engine's own 401 UNAUTHENTICATED repeats after the refresh and the access check passes", { reads: [CODE_ANSWER.engineUnauthenticated], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [CODE_ANSWER.accessOk] }],
    ["a person with no company: the access check passes with no company, the refresh works, every read is 401", { reads: [CODE_ANSWER.signInRefusedAtFront], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [CODE_ANSWER.accessWithNoCompany] }],
  ] as const)("(characterized, NOT this lane: T1a/T1b) %s: Cloud answers 501 NOT_ON_CODE_YET, unchanged", async (_name, script) => {
    const w = setUp({ reads: [...script.reads], refreshes: [...script.refreshes], accesses: [...script.accesses] });
    await w.start();
    const answer = await w.read();
    const body = answer.body as { error?: { code?: string; message?: string } };
    expect({ status: answer.status, code: body.error?.code, words: body.error?.message }, `Code was asked: ${w.trail.join(" -> ")}`).toEqual({ status: 501, code: "NOT_ON_CODE_YET", words: NOT_ON_CODE });
  });

  it("(what the screen does today with that 501) the app keeps the earlier private data on screen, marked stale ('Reconnecting'), and does not send the person to sign in: right for a member whose read failed, wrong for anyone whose access has ended", async () => {
    const w = setUp({ reads: [CODE_ANSWER.engineUnauthenticated], refreshes: [() => CODE_ANSWER.refreshRenewed(1)], accesses: [CODE_ANSWER.accessOk] });
    await w.start();
    const answer = await w.read();
    expect(answer.status).toBe(501);
    const screen = await screenAfter(answer);
    expect({ keptData: screen.keptData, sentToSignIn: screen.sentToSignIn.mock.calls.length, status: screen.error?.status }).toEqual({ keptData: true, sentToSignIn: 0, status: 501 });
  });
});
