// Meta lane F, fix round 1 (Opus review): the lease is fenced by its holder (I1), a ticket's body survives a cut-short direct start (M1), the list reply parses as its contract (M2),
// and the waiting-list size is one constant (M2). The probes of the review, turned round: each asserts the fixed behaviour.
import { describe, expect, it } from "vitest";
import { agentXError, intakeItemIdOf, IntakeWaitingListSchema, INTAKE_MAX_WAITING_PER_PROJECT, type CodeIntentRequest, type OrgId } from "@agentx/contracts";
import { ingestIntake, startWaitingIntake, type IntakeCandidate, type IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { readIntakeItem, INTAKE_START_LEASE_MS, INTAKE_MAX_WAITING_PER_PROJECT as STORE_MAX } from "../../packages/broker/src/intake/store.js";
import { INTAKE_PATH, routeIntakeRequest } from "../../packages/broker/src/intake/routes.js";
import { replaceIntakeSources } from "../../packages/broker/src/intake/sources.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "web";
const A = "a".repeat(64);
const B = "b".repeat(64);
const REF = { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };
const ITEM = intakeItemIdOf("jira", "PAY-12");

function world() {
  const db = new FakeDynamoDb();
  const clock = { now: Date.parse("2026-10-31T10:00:00.000Z") };
  const starts: Array<{ developerId: string; request: CodeIntentRequest }> = [];
  const gates: Array<{ release: (outcome: "ok" | "refuse" | "crash") => void }> = [];
  let tasks = 0;
  const ports: IntakePorts = {
    table: { documentClient: db, tableName: "state", now: () => clock.now },
    log: () => undefined,
    memberOfAccount: async (_o, _s, account) => (account === "acct-a" ? A : undefined),
    mayStart: async (_o, developerId) => developerId === A || developerId === B,
    start: (_o, developerId, request) => new Promise((resolve, reject) => {
      starts.push({ developerId, request });
      gates.push({ release: (outcome) => {
        if (outcome === "ok") { tasks += 1; resolve({ task: { taskId: `task-${String(tasks)}` }, sessionId: `ses_${String(tasks).padStart(20, "0")}` }); }
        else if (outcome === "refuse") reject(agentXError("CONFIG_INVALID", "refused"));
        else reject(new Error("crash"));
      } });
    }),
    sessionOfTicket: async () => undefined,
  };
  return { db, clock, ports, starts, gates };
}

const ticket = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: PROJECT, channel: "jira", externalRef: REF, title: "Refunds fail", body: "Refunds over 100 fail with a 500.", reporter: { display: "Dana" },
  actor: { kind: "person", accountId: "acct-a", display: "Maya" }, ...over,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = async (w: ReturnType<typeof world>) => (await readIntakeItem(w.ports.table, ORG, PROJECT, ITEM));

describe("I1: only the holder of the lease can give back, release or finish a start", () => {
  async function takenOver() {
    const w = world();
    const first = ingestIntake(w.ports, ticket());
    await tick();
    w.clock.now += INTAKE_START_LEASE_MS + 1;
    const second = startWaitingIntake(w.ports, { orgId: ORG, project: PROJECT, itemId: ITEM, approver: B });
    await tick(); await tick();
    expect(w.starts).toHaveLength(2);
    return { w, first, second };
  }

  it("a stale holder's late refusal leaves the taker's start where it was, and the taker's success is recorded as started", async () => {
    const { w, first, second } = await takenOver();
    w.gates[0]!.release("refuse");
    await first;
    expect((await state(w))?.state).toBe("starting");
    w.gates[1]!.release("ok");
    expect(await second).toMatchObject({ outcome: "started" });
    expect(await state(w)).toMatchObject({ state: "started", startedBy: B });
  });

  it("a stale holder's late crash does not forget the taker's item", async () => {
    const { w, first, second } = await takenOver();
    w.gates[0]!.release("crash");
    await expect(first).rejects.toThrow();
    expect(await state(w)).toMatchObject({ state: "starting", startedBy: B });
    w.gates[1]!.release("ok");
    await second;
    expect((await state(w))?.state).toBe("started");
  });

  it("a stale holder's late success cannot overwrite the taker's: it counts as a duplicate, and never throws", async () => {
    const { w, first, second } = await takenOver();
    w.gates[1]!.release("ok");
    expect(await second).toMatchObject({ outcome: "started" });
    w.gates[0]!.release("ok");
    expect(["started", "duplicate"]).toContain((await first).outcome);
    expect(await state(w)).toMatchObject({ state: "started", startedBy: B });
  });

  it("a start that worked is never a thrown fault when the item can no longer be marked (the taker finished first)", async () => {
    const w = world();
    const first = ingestIntake(w.ports, ticket());
    await tick();
    // The item is gone (expired or removed) while the start runs.
    w.db.delete({ pk: `ORG#${ORG}#INTAKE_ITEM#${PROJECT}`, sk: ITEM });
    w.gates[0]!.release("ok");
    expect(["started", "duplicate"]).toContain((await first).outcome);
  });
});

describe("M1: a direct start that was cut short keeps the ticket's body for the next start", () => {
  it("a member's Start after the lease ran out carries the body", async () => {
    const w = world();
    void ingestIntake(w.ports, ticket());
    await tick();
    w.clock.now += INTAKE_START_LEASE_MS + 1;
    const second = startWaitingIntake(w.ports, { orgId: ORG, project: PROJECT, itemId: ITEM, approver: B });
    await tick(); await tick();
    expect(w.starts[1]!.request.input.context?.[0]?.body).toContain("Refunds over 100");
    w.gates[1]!.release("ok");
    await second;
  });
});

describe("M2: the list reply is the contract", () => {
  it("parses as IntakeWaitingListSchema, sources included, and the cap is one constant", async () => {
    const w = world();
    await ingestIntake(w.ports, ticket({ actor: { kind: "person", accountId: "nobody" } }));
    await replaceIntakeSources(w.ports.table, { orgId: ORG, project: PROJECT, refs: [{ channel: "tracker", system: "sim", when: { label: "rovara" } }], setBy: A });
    const match = INTAKE_PATH.exec(`/v1/app/projects/${PROJECT}/intake`)!;
    const reply = await routeIntakeRequest({ ports: w.ports, projectFor: async () => ({ name: PROJECT, role: "contributor" }) }, { developerId: A, orgId: ORG } as never, "GET", match, undefined);
    const parsed = IntakeWaitingListSchema.safeParse(reply.body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.sources).toHaveLength(1);
    expect(INTAKE_MAX_WAITING_PER_PROJECT).toBe(200);
    expect(STORE_MAX).toBe(INTAKE_MAX_WAITING_PER_PROJECT);
  });
});
