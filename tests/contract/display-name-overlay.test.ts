// Release 0.4.18, review items: work and approvals written BEFORE a person chose a name stored the name they had then (the placeholder), so the screens that show them
// read the chosen name at read time, keyed by the stored developer id (never by the stored name), one BatchGetItem per list. The chosen name goes through the same email-safe rule.
import { randomUUID } from "node:crypto";
import { BatchGetCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { agentSessionKey, mySessionsKey } from "../../packages/contracts/src/index.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { listSessions, sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { createWriteApprovalRecord, getAnyApproval } from "../../packages/broker/src/agents/approvals-store.js";
import { approvalView, withChosenOwners } from "../../packages/broker/src/agents/approval-routes.js";
import { agentRunStarterOf } from "../../packages/broker/src/aws/developer-routes.js";
import { ARJUN, CELL, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const CHOSEN = "Priya R";
const nameItem = (developerId: string, name: unknown) => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, name, chosenAt: "2026-10-27T09:00:00.000Z" });

/** The sessions world with a recording client, and every session's owner stored as the placeholder, as work from before the rename has it. */
function world() {
  const w = sessionWorld();
  const sent: unknown[] = [];
  const documentClient = { send: (command: never) => { sent.push(command); return w.db.send(command); } };
  const deps: SessionReadDependencies = {
    documentClient, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
  };
  const placeholder = placeholderDisplayName(PRIYA);
  const seed = () => {
    const seeded = w.seedSession({ owner: PRIYA });
    const meta = w.db.get(agentSessionKey(ORG_A, seeded.sessionId, "META"))!;
    w.db.set({ ...meta, owner: { developerId: PRIYA, name: placeholder } });
    w.db.set({ ...mySessionsKey(ORG_A, PRIYA, `2026-10-22T08:0${String(sent.length % 10)}:00.000Z`, seeded.sessionId), sessionId: seeded.sessionId, orgId: ORG_A });
    return seeded.sessionId;
  };
  const chosenReads = () => sent.filter((command) => command instanceof GetCommand && String((command.input.Key as { pk: string }).pk).startsWith("DEVELOPER_NAME#"));
  const chosenBatches = () => sent.filter((command) => command instanceof BatchGetCommand && JSON.stringify(command.input).includes("DEVELOPER_NAME#"));
  return { w, deps, placeholder, seed, sent, chosenReads, chosenBatches };
}

describe("a session started before the rename", () => {
  it("shows the chosen name as the owner and the payer on the session page", async () => {
    const { w, deps, placeholder, seed } = world();
    const sessionId = seed();
    expect((await sessionView(deps, w.caller(PRIYA), sessionId)).owner.name).toBe(placeholder);
    w.db.set(nameItem(PRIYA, CHOSEN));
    const view = await sessionView(deps, w.caller(PRIYA), sessionId);
    expect(view.owner).toEqual({ developerId: PRIYA, name: CHOSEN });
    expect(view.cost.payer.name).toBe(CHOSEN);
  });

  it("is keyed by the stored owner id: another person's chosen name never lands on the owner, and the stored name is not consulted", async () => {
    const { w, deps, placeholder, seed } = world();
    const sessionId = seed();
    w.db.set(nameItem(ARJUN, "Arjun K"));
    expect((await sessionView(deps, w.caller(PRIYA), sessionId)).owner.name).toBe(placeholder);
  });

  it("never lets an email back in: an item holding an address reads as the placeholder", async () => {
    const { w, deps, placeholder, seed } = world();
    const sessionId = seed();
    w.db.set(nameItem(PRIYA, "priya@example.com"));
    const view = await sessionView(deps, w.caller(PRIYA), sessionId);
    expect(JSON.stringify(view)).not.toContain("@");
    expect(view.owner.name).toBe(placeholder);
  });

  it("shows it on every tile of the list, with one BatchGetItem for the page and no read per row", async () => {
    const { w, deps, seed, chosenReads, chosenBatches } = world();
    const ids = [seed(), seed(), seed()];
    w.db.set(nameItem(PRIYA, CHOSEN));
    const list = await listSessions(deps, w.caller(PRIYA), { owner: "me" });
    expect(list.sessions.map((tile) => tile.sessionId).sort()).toEqual([...ids].sort());
    expect(list.sessions.map((tile) => tile.owner.name)).toEqual([CHOSEN, CHOSEN, CHOSEN]);
    expect(chosenBatches()).toHaveLength(1);
    expect(chosenReads()).toEqual([]);
  });

  it("leaves a tile as stored when its owner chose no name", async () => {
    const { w, deps, placeholder, seed } = world();
    seed();
    const list = await listSessions(deps, w.caller(PRIYA), { owner: "me" });
    expect(list.sessions.map((tile) => tile.owner.name)).toEqual([placeholder]);
  });
});

describe("an approval made before the rename", () => {
  const approvalId = "apr_aaaaaaaaaaaaaaaaaaaa";
  const owner = "d".repeat(64);
  async function approval() {
    const db = new FakeDynamoDb();
    const deps = { documentClient: db as never, tableName: "state", now: Date.now };
    const created = await createWriteApprovalRecord(deps, {
      orgId: TEST_ORG, approvalId, kind: "write", subject: { kind: "agent_run", taskId: randomUUID(), stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: "Create an issue", class: "consequential", approvers: { kind: "ids", ids: [owner] }, status: "PENDING", project: "payments", owner: { developerId: owner, name: placeholderDisplayName(owner) },
      attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never, [], 8);
    expect(created).toBe("created");
    return { db, deps };
  }

  const viewed = async (deps: never) => {
    const records = await withChosenOwners(deps, [(await getAnyApproval(deps, TEST_ORG, approvalId))!]);
    return approvalView({ confirmOrigin: "https://cell.example" }, records[0]!) as { owner: { name: string } };
  };

  it("names the run's owner by the chosen name in the view, keyed by the stored owner's id", async () => {
    const { db, deps } = await approval();
    expect((await viewed(deps as never)).owner.name).toBe(placeholderDisplayName(owner));
    db.set(nameItem("f".repeat(64), "Someone Else"));
    expect((await viewed(deps as never)).owner.name).toBe(placeholderDisplayName(owner));
    db.set(nameItem(owner, "Dee D"));
    expect((await viewed(deps as never)).owner.name).toBe("Dee D");
  });

  it("reads a list's owners with one BatchGetItem, and a single read adds no read to getAnyApproval", async () => {
    const { db, deps } = await approval();
    db.set(nameItem(owner, "Dee D"));
    const sent: unknown[] = [];
    const counting = { ...deps, documentClient: { send: (command: never) => { sent.push(command); return db.send(command); } } };
    const record = (await getAnyApproval(counting, TEST_ORG, approvalId))!;
    expect(sent).toHaveLength(1);
    await withChosenOwners(counting, [record, record, record]);
    expect(sent.filter((command) => command instanceof BatchGetCommand)).toHaveLength(1);
    expect(sent.filter((command) => command instanceof GetCommand)).toHaveLength(1);
  });

  it("never lets an email back in through the chosen name", async () => {
    const { db, deps } = await approval();
    db.set(nameItem(owner, "dee@example.com"));
    expect(JSON.stringify(await viewed(deps as never))).not.toContain("@");
  });
});

describe("an agent or trigger run started after the rename", () => {
  const person = "e".repeat(64);
  function starter() {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVELOPER#${person}`, sk: "META", developerId: person, provider: "oidc", displayName: "Omar Diaz", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const deps = {
      documentClient: db, tableName: "state", developer: { signInTableName: "signin" }, agents: {},
      orgs: { orgForDeveloper: async () => ({ orgId: TEST_ORG, role: "member" }) },
    };
    return { db, run: agentRunStarterOf(deps as never)! };
  }

  it("is named by the chosen name, where the sign-in record has the old one", async () => {
    const { db, run } = starter();
    expect((await run.callerFor(TEST_ORG, person))?.name).toBe("Omar Diaz");
    db.set(nameItem(person, "Omar D"));
    expect((await run.callerFor(TEST_ORG, person))?.name).toBe("Omar D");
  });

  it("never names the person by an address", async () => {
    const { db, run } = starter();
    db.set(nameItem(person, "omar@example.com"));
    expect((await run.callerFor(TEST_ORG, person))?.name).not.toContain("@");
  });
});
