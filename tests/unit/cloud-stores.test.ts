// Cloud's stores (PrepLabsAI/Rovara-cloud#11): the same cases against the local stores (one server) and the DynamoDB stores
// (several servers share one table), the DynamoDB ones on DynamoDB Local in Docker.
import { execFileSync } from "node:child_process";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLOUD_TABLE, DynamoPresenceBoard, DynamoSessionStore, DynamoWorkSessionStore, LocalPresenceBoard, LocalSessionStore, LocalWorkSessionStore,
  PENDING_LIFETIME_S, PRESENCE_TTL_MS, PRESENCE_VIEWERS_MAX, SIGN_IN_LIFETIME_S, StoreConflict, cloudDocumentClient,
  type CodeSession, type PendingSignIn, type PresenceBoard, type SessionComment, type SessionStore, type WorkSession, type WorkSessionStore,
} from "../../packages/cloud-server/src/index.js";

const IMAGE = "amazon/dynamodb-local:2.6.1";
const docker = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!docker) console.warn("cloud-stores.test.ts: Docker isn't running, so the DynamoDB stores are not tested here.");

const ADA = { developerId: "a".repeat(64), name: "Ada" };
const GRACE = { developerId: "f".repeat(64), name: "Grace" };
const signIn = (token: string): CodeSession => ({
  accessToken: token, refreshToken: `refresh-${token}`, csrf: "csrf", signedInAt: "2026-11-14T12:00:00.000Z",
  access: { developerId: ADA.developerId, displayName: "Ada", administrator: false, projects: [], notices: [] },
});
const pending = (state: string) => ({ state, verifier: "v", returnTo: "/app", at: 1 }) as unknown as PendingSignIn;
let made = 0;
const session = (who = ADA, createdAt = "2026-11-14T12:00:00.000Z"): WorkSession => ({
  sessionId: `ses_${String(made++).padStart(20, "0")}`, taskId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", project: "payments",
  startedBy: who, owner: who, createdAt, revision: 1,
});
const comment = (index: number, text = `comment ${String(index)}`): SessionComment => ({
  messageId: `msg_${String(index).padStart(20, "0")}`, kind: "comment", source: "app", author: ADA, text,
  createdAt: new Date(Date.UTC(2026, 10, 14, 12, 0, 0, index)).toISOString(), rev: 1,
});

interface Stores { sessions: SessionStore; work: WorkSessionStore; presence: PresenceBoard; second: () => { work: WorkSessionStore; presence: PresenceBoard } }

function contract(name: string, make: () => Stores) {
  describe(name, () => {
    it("keeps a sign-in until it is deleted, without the request's `changed` mark", async () => {
      const { sessions } = make();
      await sessions.put("cookie-1", { ...signIn("t1"), changed: true });
      expect(await sessions.get("cookie-1")).toEqual(signIn("t1"));
      await sessions.delete("cookie-1");
      expect(await sessions.get("cookie-1")).toBeUndefined();
    });

    it("hands out a sign-in under way once", async () => {
      const { sessions } = make();
      await sessions.putPending("state-1", pending("state-1"));
      expect(await sessions.takePending("state-1")).toEqual(pending("state-1"));
      expect(await sessions.takePending("state-1")).toBeUndefined();
      expect(await sessions.takePending("never")).toBeUndefined();
    });

    it("creates a session once, finds it by its start request, and counts its versions", async () => {
      const { work } = make();
      const fresh = session();
      await work.put(fresh, "22222222-2222-4222-8222-222222222222");
      const read = await work.get(fresh.sessionId);
      expect(read).toEqual({ ...fresh, storeVersion: 0 });
      expect(await work.byRequest("22222222-2222-4222-8222-222222222222")).toEqual(read);
      await expect(work.put({ ...fresh })).rejects.toBeInstanceOf(StoreConflict);
      await work.put({ ...read!, followers: [GRACE] });
      expect(await work.get(fresh.sessionId)).toEqual({ ...fresh, followers: [GRACE], storeVersion: 1 });
    });

    it("refuses a write on a session someone else wrote since it was read, and keeps their change", async () => {
      const stores = make();
      const fresh = session();
      await stores.work.put(fresh);
      const other = stores.second().work;
      const mine = (await stores.work.get(fresh.sessionId))!, theirs = (await other.get(fresh.sessionId))!;
      await other.put({ ...theirs, followers: [GRACE] });
      await expect(stores.work.put({ ...mine, owner: GRACE })).rejects.toBeInstanceOf(StoreConflict);
      const now = (await stores.work.get(fresh.sessionId))!;
      expect(now.followers).toEqual([GRACE]);
      expect(now.owner).toEqual(ADA);
    });

    it("keeps comments in order, with edits, request ids and replies, across writes", async () => {
      const { work, second } = make();
      const fresh = session();
      await work.put(fresh);
      let read = (await work.get(fresh.sessionId))!;
      await work.put({ ...read, messages: [comment(1)], messageRequests: { r1: comment(1).messageId } });
      read = (await work.get(fresh.sessionId))!;
      const reply = { ...comment(2), threadId: comment(1).messageId };
      await work.put({ ...read, messages: [...read.messages!, reply], messageRequests: { ...read.messageRequests, r2: reply.messageId } });
      read = (await second().work.get(fresh.sessionId))!;
      const edited = { ...read.messages![0]!, text: "edited", editedAt: "2026-11-14T12:05:00.000Z", rev: 2 };
      await second().work.put({ ...read, messages: [edited, read.messages![1]!] });
      const final = (await work.get(fresh.sessionId))!;
      expect(final.messages).toEqual([edited, reply]);
      expect(final.messageRequests).toEqual({ r1: comment(1).messageId, r2: reply.messageId });
    });

    it("holds a session's most comments at their longest (500 of 2,000 characters), more than one DynamoDB item", async () => {
      const { work } = make();
      const fresh = session();
      const many = Array.from({ length: 500 }, (_, index) => comment(index, "x".repeat(2000)));
      await work.put({ ...fresh, messages: many });
      const read = (await work.get(fresh.sessionId))!;
      expect(read.messages).toHaveLength(500);
      expect(read.messages![499]).toEqual(many[499]);
      const added = comment(500, "one more");
      await work.put({ ...read, messages: [...read.messages!, added] });
      expect((await work.get(fresh.sessionId))!.messages!.at(-1)).toEqual(added);
    }, 60_000);

    it("lists the sessions a person started, newest first, without their comments", async () => {
      const { work } = make();
      const older = session(ADA, "2026-11-14T10:00:00.000Z"), newer = session(ADA, "2026-11-14T11:00:00.000Z"), hers = session(GRACE);
      for (const each of [older, newer, hers]) await work.put(each);
      const read = (await work.get(newer.sessionId))!;
      await work.put({ ...read, messages: [comment(1)], messageRequests: { r1: comment(1).messageId } });
      const listed = await work.startedBy(ADA.developerId);
      const mine = listed.filter((each) => each.sessionId === older.sessionId || each.sessionId === newer.sessionId);
      expect(mine.map((each) => each.sessionId)).toEqual([newer.sessionId, older.sessionId]);
      expect(mine[0]).not.toHaveProperty("messages");
      expect(mine[0]).not.toHaveProperty("messageRequests");
      expect(listed.some((each) => each.sessionId === hers.sessionId)).toBe(false);
    });

    it("counts a viewer for 90 seconds after their heartbeat, newest first, at most 20, across servers", async () => {
      const { presence, second } = make();
      const id = session().sessionId, start = Date.parse("2026-11-14T12:00:00.000Z");
      expect(await presence.heartbeat(id, ADA, start)).toEqual([ADA]);
      expect(await second().presence.heartbeat(id, GRACE, start + 1000)).toEqual([GRACE, ADA]);
      expect(await presence.viewing(id, start + PRESENCE_TTL_MS)).toEqual([GRACE]);
      expect(await presence.viewing(id, start + 1000 + PRESENCE_TTL_MS)).toEqual([]);
      const busy = session().sessionId;
      for (let index = 0; index < 25; index += 1) await presence.heartbeat(busy, { developerId: String(index).padStart(64, "0"), name: `P${String(index)}` }, start + index);
      const viewers = await presence.viewing(busy, start + 30);
      expect(viewers).toHaveLength(PRESENCE_VIEWERS_MAX);
      expect(viewers[0]!.name).toBe("P24");
    });
  });
}

contract("the local stores (one server)", () => {
  const presence = new LocalPresenceBoard(), work = new LocalWorkSessionStore();
  return { sessions: new LocalSessionStore(), work, presence, second: () => ({ work, presence }) };
});

describe.skipIf(!docker)("the DynamoDB stores (several servers, DynamoDB Local)", () => {
  let container = "", client: DynamoDBClient | undefined, table = "";
  const clock = { ms: Date.parse("2026-11-14T12:00:00.000Z") };

  beforeAll(async () => {
    container = execFileSync("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::8000", IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory"], { encoding: "utf8" }).trim();
    const port = execFileSync("docker", ["port", container, "8000/tcp"], { encoding: "utf8" }).trim().split(":").at(-1)!;
    client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
    table = "cloud-stores-test";
    for (let tries = 0; ; tries += 1) {
      try {
        await client.send(new CreateTableCommand({
          TableName: table, BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [CLOUD_TABLE.partitionKey, CLOUD_TABLE.sortKey, CLOUD_TABLE.startedByKey, CLOUD_TABLE.startedBySort].map((name) => ({ AttributeName: name, AttributeType: "S" })),
          KeySchema: [{ AttributeName: CLOUD_TABLE.partitionKey, KeyType: "HASH" }, { AttributeName: CLOUD_TABLE.sortKey, KeyType: "RANGE" }],
          GlobalSecondaryIndexes: [{
            IndexName: CLOUD_TABLE.startedByIndex, Projection: { ProjectionType: "ALL" },
            KeySchema: [{ AttributeName: CLOUD_TABLE.startedByKey, KeyType: "HASH" }, { AttributeName: CLOUD_TABLE.startedBySort, KeyType: "RANGE" }],
          }],
        }));
        break;
      } catch (error) {
        if (tries > 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }, 60_000);

  afterAll(() => { if (container !== "") execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); });

  const stores = (): Stores => {
    const db = cloudDocumentClient(client!);
    return {
      sessions: new DynamoSessionStore(db, table, () => clock.ms), work: new DynamoWorkSessionStore(db, table), presence: new DynamoPresenceBoard(db, table),
      // Another server: its own clients and stores, on the same table.
      second: () => { const other = cloudDocumentClient(client!); return { work: new DynamoWorkSessionStore(other, table), presence: new DynamoPresenceBoard(other, table) }; },
    };
  };
  contract("the shared cases", stores);

  it("forgets a sign-in 30 days after it was last saved, and a sign-in under way after ten minutes", async () => {
    const { sessions } = stores();
    await sessions.put("cookie-old", signIn("old"));
    await sessions.putPending("state-old", pending("state-old"));
    clock.ms += (PENDING_LIFETIME_S + 1) * 1000;
    expect(await sessions.takePending("state-old")).toBeUndefined();
    expect(await sessions.get("cookie-old")).toEqual(signIn("old"));
    clock.ms += SIGN_IN_LIFETIME_S * 1000;
    expect(await sessions.get("cookie-old")).toBeUndefined();
  });
});
