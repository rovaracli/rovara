// Plan 5 Task 3 (built at the merge of Plans 4 and 5): a chain run is one session, created in the run's own start transaction. `sessionId` is the run's id, the owner's name is read
// before the transaction, the step tasks get no session of their own (the run's is theirs), and a start that is refused writes no session.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { startChainRun } from "../../packages/broker/src/chains/runner.js";
import { AgentSessionRecordSchema } from "@rovara-code/contracts";
import { agentSessionKey, liveSessionKey, mySessionsKey, openAgentSessionKey, projectSessionsKey } from "@rovara-code/contracts";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { ARJUN, MAX, ORG_A, PRIYA, callerOf, setupWorld, type ChainWorld } from "../support/chain-run-world.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });
afterAll(async () => { (await loadSlackBroker() as unknown as { uninstallChainRunner(): void }).uninstallChainRunner(); });

const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 30 } };
const TRIGGER_ID = "ctr_aaaaaaaaaaaaaaaaaaaa";

function world() {
  const w = setupWorld();
  w.db.set({ pk: `DEVELOPER#${PRIYA}`, sk: "META", developerId: PRIYA, displayName: "Priya Shah" });
  return w;
}

const start = (w: ChainWorld, who: string, chainId: string, extra: Record<string, unknown> = {}) =>
  startChainRun(w.deps, callerOf(who), { orgId: ORG_A, chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: who }, requestId: randomUUID(), ...extra } as never);
const startEvent = (w: ChainWorld, chainId: string, owner: string, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  startChainRun(w.deps, { system: "event", owner: { developerId: owner } }, {
    orgId: ORG_A, chainId, project: "web", origin: "event", requestId: randomUUID(), trigger,
    startedBy: { kind: "event", triggerId: TRIGGER_ID, eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title: "Refund errors" }, ...extra,
  } as never);
const sessionOf = (w: ChainWorld, runId: string) => w.db.get(agentSessionKey(ORG_A, runId, "META").pk, "META");
const withoutKeys = ({ pk: _pk, sk: _sk, entityType: _entityType, ...record }: Record<string, unknown>) => record; // eslint-disable-line @typescript-eslint/no-unused-vars

describe("a chain run is one session", () => {
  it("writes the run and its session in one transaction: the session id is the run id, the owner's name is read, and the session is listed everywhere a session is", async () => {
    const w = world();
    const chain = await w.publish(ONE_STEP);
    const run = await start(w, PRIYA, chain.chainId, { input: "Why did checkout fail?\nIt started at noon." });
    const session = AgentSessionRecordSchema.parse(withoutKeys(sessionOf(w, run.runId)!));
    expect(session).toMatchObject({
      sessionId: run.runId, kind: "chain", mode: "delegate", subject: { kind: "chain", chainRunId: run.runId }, where: { kind: "cloud" }, project: "web",
      owner: { developerId: PRIYA, name: "Priya Shah" }, startedBy: { kind: "member", developerId: PRIYA }, origin: "app", payer: run.payer, revision: 1, followerCount: 0,
      title: `${run.chainName}: Why did checkout fail?`, summary: { status: "starting" },
    });
    expect(session.agent).toBeUndefined();
    expect(session.legs).toEqual([{ seq: 1, subject: { kind: "chain", chainRunId: run.runId }, where: { kind: "cloud" }, startedAt: run.createdAt }]);
    for (const key of [mySessionsKey(ORG_A, PRIYA, run.createdAt, run.runId), projectSessionsKey(ORG_A, "web", run.createdAt, run.runId), liveSessionKey(ORG_A, run.runId), openAgentSessionKey(ORG_A, run.runId)]) {
      expect(w.db.get(key.pk, key.sk), key.pk).toBeDefined();
    }
    expect(w.db.find((item) => item.pk === agentSessionKey(ORG_A, run.runId, "META").pk && String(item.sk).startsWith("EVENT#")).map((item) => item.type)).toEqual(["started"]);
  });

  it("gives none of the step tasks a session of their own, and finds the run's session from a step's task", async () => {
    const w = world();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await start(w, PRIYA, chain.chainId);
    const [task] = [...w.tasks.values()];
    const record = w.db.get(`DEVTASK#${task!.taskId}`, "META")!;
    expect(record["sessionId"]).toBeUndefined();
    const found = await new AgentSessionStore({ documentClient: w.db, tableName: "T" } as never).getForTask(ORG_A, record as never);
    expect(found?.sessionId).toBe(run.runId);
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(1);
  });

  it("names an event-started run's starter by its trigger, and stores a trigger title inert and redacted", async () => {
    const w = world();
    const chain = await w.publish(ONE_STEP);
    const token = `ghp_${"a1".repeat(18)}`;
    const title = `<!channel> check ${token}`;
    const run = await startEvent(w, chain.chainId, MAX, { eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", subject: { kind: "alert", title } }, {
      startedBy: { kind: "event", triggerId: TRIGGER_ID, eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title },
    });
    const session = sessionOf(w, run.runId)!;
    expect(session["startedBy"]).toEqual({ kind: "event", triggerId: TRIGGER_ID });
    expect(session["origin"]).toBe("event");
    expect(session["owner"]).toMatchObject({ developerId: MAX });
    expect(String(session["title"])).not.toContain("<!channel>");
    expect(String(session["title"])).not.toContain(token);
    expect(String(session["title"])).toContain("check");
  });

  it("writes no session for a start that is refused, and one session for a start asked twice", async () => {
    const w = world();
    const chain = await w.publish(ONE_STEP);
    await expect(start(w, ARJUN, chain.chainId)).rejects.toBeDefined();
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(0);
    const requestId = randomUUID();
    const first = await start(w, PRIYA, chain.chainId, { requestId });
    const again = await start(w, PRIYA, chain.chainId, { requestId });
    expect(again.runId).toBe(first.runId);
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(1);
  });
});
