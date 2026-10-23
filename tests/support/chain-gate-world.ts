// Plan 4 Task 8: a world for the tests of chain gates and of autonomous write approvals. It is Task 6's chain-run world with Plan 3's approvals on top of it: the
// real decide page (`routeDecidePage` over `approvalDecideKind`), decide tickets and sessions as the sign-in function writes them, and the approval routes. Nothing here
// is Plan 4's code: the tests start runs, end tasks and decide on the page, and read the records through `world.run`, `world.attempts`, `world.events` and `world.approval`.
import { createHash, randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { routeApprovalRequest } from "../../packages/broker/src/agents/approval-routes.js";
import { getAnyApproval, type AnyApprovalRecord, type ApprovalDependencies, type StepApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import type { DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, mintConfirmUrl, requireDecideSession, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import { registerChainRunner } from "../../packages/broker/src/chains/index.js";
import type { ChainRunRecord, ChainRunnerDependencies, StepAttemptRecord } from "../../packages/broker/src/chains/runner.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { INVESTIGATE_THEN_FIX } from "./chain-examples.js";
import { ARJUN, CARL, DANA, MAX, NAMES, ORG_A, ORG_B, PRIYA, STRANGER, VIV, callerOf, setupWorld, type WorldOptions } from "./chain-run-world.js";

export { ARJUN, CARL, DANA, MAX, NAMES, ORG_A, ORG_B, PRIYA, STRANGER, VIV, callerOf };
export const CELL = "https://cell.example.com";
const disposers: Array<() => void> = [];
/** Takes off what every world registered (the runner's handlers, the gate and write approver registrations). Call it after each test. */
export function disposeGateWorlds(): void {
  for (const dispose of disposers.splice(0)) dispose();
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** One line the broker logged. */
export interface LoggedLine { event: string; fields: Record<string, unknown> }

type PageOptions = { method?: "GET" | "POST"; cookie?: string; fields?: Record<string, string>; headers?: Record<string, string>; ticket?: string };

export function setupGateWorld(options: WorldOptions = {}) {
  const world = setupWorld(options);
  const logs: LoggedLine[] = [];
  // The people's names, as the sign-in store holds them: a decision's event names who decided.
  for (const [developerId, name] of Object.entries(NAMES)) world.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  const decideStore = new DecideStore({ documentClient: world.db, tableName: "T", now: () => world.clock.now });
  const bearers = new Map<string, { developerId: string; orgId: typeof ORG_A }>(
    [[PRIYA, "priya"], [MAX, "max"], [CARL, "carl"], [DANA, "dana"], [VIV, "viv"], [ARJUN, "arjun"]].map(([developerId, name]) => [`Bearer ${name!}`, { developerId: developerId!, orgId: ORG_A }]),
  );
  // The runner's dependencies are also the approvals': the same object serves the decide page, the routes and the runner.
  const deps: ChainRunnerDependencies & ApprovalDependencies = {
    ...world.deps, log: (event, fields) => logs.push({ event, fields }),
    mintConfirmUrl: (who, approvalId) => mintConfirmUrl(context(), { developerId: who.developerId, orgId: who.orgId }, approvalId),
  } as ChainRunnerDependencies & ApprovalDependencies;
  // What the broker registers at start: the runner's handlers, the gate's rule and handler, and the autonomous write rule with its selector (chains/index.ts).
  disposers.push(registerChainRunner(() => deps));
  const kind = approvalDecideKind(deps);
  function context(kinds: DecideKinds = { apr: kind }): DecideRequestContext {
    return {
      store: decideStore, now: () => world.clock.now, cellOrigin: CELL, kinds,
      authenticateBearer: async (authorization) => {
        const found = bearers.get(authorization);
        if (found === undefined) throw agentXError("AUTH_REQUIRED", "a valid sign-in is required");
        return found;
      },
    };
  }

  /** A session as the sign-in function writes it after a fresh email-code sign-in `agoSeconds` ago. */
  let counter = 0;
  const session = async (developerId: string, approvalId: string, session: { orgId?: typeof ORG_A; agoSeconds?: number } = {}) => {
    counter += 1;
    const cookie = `cookie-${String(counter)}-${"x".repeat(40)}`;
    const signedInAt = Math.floor(world.clock.now / 1000) - (session.agoSeconds ?? 30);
    await decideStore.putSession(cookie, { orgId: session.orgId ?? ORG_A, developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const page = (approvalId: string, pageOptions: PageOptions = {}) => {
    const method = pageOptions.method ?? "GET";
    const query = pageOptions.ticket === undefined ? "" : `?ticket=${pageOptions.ticket}`;
    return routeDecidePage(context(), {
      method, path: `/v1/app/approve/${approvalId}`, requestId: "r",
      headers: {
        ...(pageOptions.cookie === undefined ? {} : { cookie: `${DECIDE_COOKIE}=${pageOptions.cookie}` }),
        ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}), ...pageOptions.headers,
      },
      ...(pageOptions.fields === undefined ? {} : { body: new URLSearchParams(pageOptions.fields).toString() }),
    }, new URL(`${CELL}/v1/app/approve/${approvalId}${query}`));
  };
  /** Approves or declines on the page as `cookie`'s member, with the page's own CSRF token. */
  const decide = (approvalId: string, cookie: string, decision: "approve" | "decline" = "approve") =>
    page(approvalId, { method: "POST", cookie, fields: { decision, csrf: csrfTokenFor(cookie) } });
  /** What a person does from the app: a fresh sign-in session, then the page's decision. */
  const decideAs = async (developerId: string, approvalId: string, decision: "approve" | "decline" = "approve", session_: { agoSeconds?: number } = {}) =>
    decide(approvalId, await session(developerId, approvalId, session_), decision);

  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, path, requestId: "r", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  /** An approval route called as `caller` (what the app, the CLI and the MCP tools reach). */
  const route = (caller: AgentCaller, method: string, path: string, body?: unknown, over: Partial<ApprovalDependencies> = {}) =>
    routeApprovalRequest({ ...deps, ...over } as ApprovalDependencies, caller, request(method, path, body), new URL(`${CELL}${path}`)) as Promise<Record<string, unknown>>;
  /** The decide route as a CLI or MCP token reaches it: through the presence guard, which refuses a token. */
  const tokenDecide = (developerId: string, approvalId: string, authorization: string, decision: "APPROVE" | "DECLINE" = "APPROVE") => {
    const gate = (r: Parameters<typeof requireDecideSession>[1]) => requireDecideSession(context(), r);
    return routeApprovalRequest({ ...deps, requireDecide: gate } as unknown as ApprovalDependencies, callerOf(developerId), {
      method: "POST", path: `/v1/app/approvals/${approvalId}/decide`, requestId: "r", headers: { authorization }, body: JSON.stringify({ requestId: randomUUID(), decision }),
    }, new URL(`${CELL}/v1/app/approvals/${approvalId}/decide`));
  };
  /** The decide route as the API reaches it with a fresh sign-in session's authority (the page's own authority, without its HTML). */
  const decideRoute = (developerId: string, approvalId: string, decision: "APPROVE" | "DECLINE" = "APPROVE") => {
    const proof = { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date(world.clock.now - 30_000).toISOString(), sessionRef: "d".repeat(64) };
    const authorized = { ...deps, requireDecide: async () => ({ orgId: ORG_A, developerId, proof, finish: async () => undefined, release: async () => undefined }) } as unknown as ApprovalDependencies;
    return routeApprovalRequest(authorized, callerOf(developerId), {
      method: "POST", path: `/v1/app/approvals/${approvalId}/decide`, requestId: "r", headers: {}, body: JSON.stringify({ decision }),
    }, new URL(`${CELL}/v1/app/approvals/${approvalId}/decide`));
  };

  // ---- runs
  const runner = () => import("../../packages/broker/src/chains/runner.js");
  /** Starts a run of `chainId` on web as `startedBy`. */
  const start = async (chainId: string, startedBy: string = PRIYA, requestId: string = randomUUID()): Promise<ChainRunRecord> => {
    const { startChainRun: startRun } = await runner();
    return startRun(deps, callerOf(startedBy), { orgId: ORG_A, chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: startedBy }, requestId } as never);
  };
  /** Ends the task most recently started, as the agent's run would. */
  const endLatest = async (extra: Record<string, unknown> = {}) => {
    const { onStepTaskEnded: end } = await runner();
    await end(deps, world.endEvent(`task-${String(world.tasks.size)}`, { finalReport: "the report", ...extra }));
  };
  /** Publishes `INVESTIGATE_THEN_FIX` (or `definition`), starts it as `startedBy` and ends the investigation with `fix`: the run waits at its gate (seq 2). */
  const runAtGate = async (startedBy: string = PRIYA, definition: ChainDefinitionInput = INVESTIGATE_THEN_FIX) => {
    const chain = await world.publish(definition);
    const run = await start(chain.chainId, startedBy);
    await endLatest({ branch: "fix" });
    const gate = world.attempts(run.runId).find((attempt) => attempt.kind === "gate" && attempt.status === "waiting")!;
    return { chain, run, gate, approvalId: gate.approvalId! };
  };
  const approval = async (approvalId: string): Promise<AnyApprovalRecord> => (await getAnyApproval(deps, ORG_A, approvalId as never))!;
  const stepApproval = async (approvalId: string): Promise<StepApprovalRecord> => (await approval(approvalId)) as StepApprovalRecord;
  const attempt = (runId: string, seq: number): StepAttemptRecord | undefined => world.attempts(runId).find((candidate) => candidate.seq === seq);
  /** The text of every `gate_decided` event of the run. */
  const decidedEvents = (runId: string) => world.events(runId).filter((event) => event.type === "gate_decided");

  return {
    ...world, deps, logs, kind, decideStore, context, session, page, decide, decideAs, route, tokenDecide, decideRoute, start, endLatest, runAtGate, approval, stepApproval, attempt, decidedEvents,
    stranger: () => callerOf(STRANGER, ORG_B),
  };
}
export type GateWorld = ReturnType<typeof setupGateWorld>;
