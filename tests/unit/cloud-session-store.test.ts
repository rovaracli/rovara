// Cloud's stored logins (migration plan v3.2, 7.2 change 4): a person's Code tokens kept in a table with expiry, sealed
// with a key only Cloud's server may use (envelope encryption), under a hash of the cookie, never the cookie itself;
// idle and absolute limits; a refreshed token saved before the call is retried, under a conditional write, so two
// servers refreshing at once neither both win nor lose the session; the client secret read at run time and never logged;
// the file store refused anywhere deployed.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
  ClientSecretUnavailable, CodeClient, DynamoPendingSignIns, DynamoSessionTable, EnvelopeSealer, KmsKeyService, LocalSessionStore, LocalSessionTable, SESSION_ABSOLUTE_MS, SealedRecordRefused,
  SESSION_IDLE_MS, SessionKeeper, isDeployedEnvironment, localKeyService, secretsManagerSecret, sessionKey, type CodeSession, type SessionRecord,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const T0 = Date.parse("2026-11-15T09:00:00.000Z");
const SECRET = `s-${randomBytes(12).toString("hex")}`;

const session = (over: Partial<CodeSession> = {}): CodeSession => ({
  accessToken: `access-${randomBytes(6).toString("hex")}`, refreshToken: `refresh-${randomBytes(6).toString("hex")}`,
  access: { developerId: "a".repeat(64), displayName: "Ada", administrator: false, projects: [], notices: [] },
  csrf: `csrf-${randomBytes(6).toString("hex")}`, signedInAt: new Date(T0).toISOString(), ...over,
});

function keeper(options: { table?: LocalSessionTable; key?: Buffer; clock?: { ms: number }; log?: Array<Record<string, unknown>> } = {}) {
  const table = options.table ?? new LocalSessionTable();
  const clock = options.clock ?? { ms: T0 };
  const log = options.log ?? [];
  const sealer = new EnvelopeSealer(localKeyService(options.key ?? randomBytes(32)));
  return { store: new SessionKeeper({ table, sealer, now: () => clock.ms, log: (event) => log.push(event), refreshWaitMs: 5 }), table, clock, log };
}

describe("the stored login: what is kept, and where", () => {
  it("keys the record by a hash of the cookie, and keeps no raw cookie, token or CSRF token in it", async () => {
    const { store, table } = keeper();
    const id = randomBytes(32).toString("base64url");
    const kept = session();
    await store.create(id, kept);
    const rows = table.rows();
    expect(rows.map((row) => row.key)).toEqual([sessionKey(id)]);
    expect(sessionKey(id)).not.toContain(id);
    const stored = JSON.stringify(rows);
    for (const secret of [id, kept.accessToken, kept.refreshToken!, kept.csrf]) expect(stored).not.toContain(secret);
    expect(await store.get(id)).toMatchObject({ accessToken: kept.accessToken, refreshToken: kept.refreshToken, csrf: kept.csrf });
  });

  it("refuses to open a record sealed under another key, or one moved onto another person's row", async () => {
    const table = new LocalSessionTable();
    const log: Array<Record<string, unknown>> = [];
    const mine = keeper({ table, log });
    const id = randomBytes(32).toString("base64url");
    await mine.store.create(id, session());
    const other = keeper({ table, log });
    expect(await other.store.get(id)).toBeUndefined();
    expect(log.at(-1)).toEqual({ event: "cloud.session_unreadable" });

    const fresh = keeper();
    const a = randomBytes(32).toString("base64url");
    const b = randomBytes(32).toString("base64url");
    await fresh.store.create(a, session());
    await fresh.store.create(b, session());
    const rowA = fresh.table.rows().find((row) => row.key === sessionKey(a))!;
    const rowB = fresh.table.rows().find((row) => row.key === sessionKey(b))!;
    fresh.table.overwrite({ ...rowB, sealed: rowA.sealed });
    expect(await fresh.store.get(b)).toBeUndefined();
  });

  it("keeps the record when the key service fails for a passing reason (KMS throttled, the network)", async () => {
    const table = new LocalSessionTable();
    const key = randomBytes(32);
    const { store } = keeper({ table, key });
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session());
    const keys = localKeyService(key);
    const flaky = new SessionKeeper({ table, sealer: new EnvelopeSealer({ generateDataKey: (context) => keys.generateDataKey(context), unwrapDataKey: async () => { throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }); } }), now: () => T0, log: () => undefined });
    await expect(flaky.get(id)).rejects.toThrow("Rate exceeded");
    expect(table.rows()).toHaveLength(1);
    expect(await store.get(id)).toBeDefined();
  });

  it("writes an expiry time the table deletes the record by", async () => {
    const { store, table } = keeper();
    await store.create("c".repeat(43), session());
    expect(table.rows()[0]!.expiresAt).toBe(Math.ceil((T0 + SESSION_IDLE_MS) / 1000));
  });
});

describe("idle and absolute limits", () => {
  it("ends a login nobody used for the idle limit, and keeps one that is used", async () => {
    const { store, clock, table, log } = keeper();
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session());
    clock.ms = T0 + SESSION_IDLE_MS - 60_000;
    expect(await store.get(id)).toBeDefined();
    clock.ms += SESSION_IDLE_MS - 60_000;
    expect(await store.get(id)).toBeDefined();
    clock.ms += SESSION_IDLE_MS + 1;
    expect(await store.get(id)).toBeUndefined();
    expect(table.rows()).toEqual([]);
    expect(log.at(-1)).toEqual({ event: "cloud.session_expired", limit: "idle" });
  });

  it("ends a login at the absolute limit however often it is used", async () => {
    const { store, clock, log } = keeper();
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session());
    for (clock.ms = T0; clock.ms < T0 + SESSION_ABSOLUTE_MS; clock.ms += SESSION_IDLE_MS / 2) expect(await store.get(id)).toBeDefined();
    clock.ms = T0 + SESSION_ABSOLUTE_MS + 1;
    expect(await store.get(id)).toBeUndefined();
    expect(log.at(-1)).toEqual({ event: "cloud.session_expired", limit: "absolute" });
  });

  it("never lets the table's expiry run past the absolute limit", async () => {
    const { store, clock, table } = keeper();
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session());
    for (clock.ms = T0; clock.ms < T0 + SESSION_ABSOLUTE_MS - 1000; clock.ms += SESSION_IDLE_MS / 2) expect(await store.get(id)).toBeDefined();
    clock.ms = T0 + SESSION_ABSOLUTE_MS - 1000;
    expect(await store.get(id)).toBeDefined();
    expect(table.rows()[0]!.expiresAt).toBeLessThanOrEqual(Math.ceil((T0 + SESSION_ABSOLUTE_MS) / 1000));
  });
});

/** A Code install whose refresh tokens work once: presenting a used one ends the whole sign-in (Code's reuse rule). */
function rotatingCode(delayMs = 20) {
  let n = 1;
  let access = "access-1";
  let refresh = "refresh-1";
  let ended = false;
  let down = false;
  const refreshes: string[] = [];
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/v1/auth/token") {
      const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body.toString() : "");
      const presented = form.get("refresh_token") ?? "";
      refreshes.push(presented);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (down) return respond(503, { error: "temporarily_unavailable" });
      if (ended || presented !== refresh) { ended = true; return respond(400, { error: "invalid_grant" }); }
      n += 1;
      access = `access-${String(n)}`;
      refresh = `refresh-${String(n)}`;
      return respond(200, { access_token: access, refresh_token: refresh });
    }
    if (ended || headers.authorization !== `Bearer ${access}`) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    return respond(200, { ok: true });
  }) as typeof fetch;
  /** The access token runs out; the refresh token still works (once). */
  return { fetchImpl, refreshes, ended: () => ended, expire: () => { access = "expired"; }, down: (value: boolean) => { down = value; } };
}

const clientFor = (fetchImpl: typeof fetch) => new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: SECRET, redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });

describe("a refreshed token is saved before the call is retried, under a conditional write", () => {
  it("lets only one of two servers refresh at once; both answer, and the session survives", async () => {
    const code = rotatingCode();
    const table = new LocalSessionTable();
    const key = randomBytes(32);
    const servers = [keeper({ table, key }), keeper({ table, key })].map(({ store }) => {
      const client = clientFor(code.fetchImpl);
      client.useRefreshGuard(store);
      return { store, client };
    });
    const id = randomBytes(32).toString("base64url");
    await servers[0]!.store.create(id, session({ accessToken: "access-1", refreshToken: "refresh-1" }));
    code.expire();
    // Each server loaded the session before either refreshed.
    const loaded = await Promise.all(servers.map(({ store }) => store.get(id)));
    const answers = await Promise.all(servers.map(({ client }, index) => client.json<{ ok: boolean }>(loaded[index]!, "/v1/dev/access", { method: "POST", body: {} })));
    expect(answers).toEqual([{ ok: true }, { ok: true }]);
    expect(code.refreshes).toEqual(["refresh-1"]);
    expect(code.ended()).toBe(false);
    expect(await servers[0]!.store.get(id)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("saves the new tokens before the retried call answers, even when Code then refuses that call", async () => {
    const code = rotatingCode(0);
    const { store } = keeper();
    const client = clientFor(async (input, init) => {
      const answer = await code.fetchImpl(input, init);
      // The retried call (after the refresh) fails at Code; the refreshed token must already be kept.
      return new URL(input instanceof Request ? input.url : input).pathname === "/v1/dev/fails" && answer.status === 200 ? new Response("{}", { status: 500 }) : answer;
    });
    client.useRefreshGuard(store);
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session({ accessToken: "access-1", refreshToken: "refresh-1" }));
    code.expire();
    const loaded = (await store.get(id))!;
    await expect(client.json(loaded, "/v1/dev/fails")).rejects.toMatchObject({ status: 500 });
    expect(await store.get(id)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("keeps the session when Code's token endpoint is down: 503, the hold released, and a later refresh works", async () => {
    const code = rotatingCode(0);
    const { store } = keeper();
    const client = clientFor(code.fetchImpl);
    client.useRefreshGuard(store);
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session({ accessToken: "access-1", refreshToken: "refresh-1" }));
    code.expire();
    code.down(true);
    await expect(client.json((await store.get(id))!, "/v1/dev/access")).rejects.toMatchObject({ status: 503 });
    expect(await store.get(id)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
    code.down(false);
    expect(await client.json((await store.get(id))!, "/v1/dev/access")).toEqual({ ok: true });
    expect(await store.get(id)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("answers busy, not ended, while another server's hold runs; and refuses tokens whose hold was taken over", async () => {
    const table = new LocalSessionTable();
    const key = randomBytes(32);
    const a = keeper({ table, key });
    const b = new SessionKeeper({ table, sealer: new EnvelopeSealer(localKeyService(key)), now: () => a.clock.ms, log: () => undefined, refreshWaitMs: 1, refreshWaitLooks: 3 });
    const id = randomBytes(32).toString("base64url");
    await a.store.create(id, session({ accessToken: "access-1", refreshToken: "refresh-1" }));
    const held = (await a.store.get(id))!;
    expect(await a.store.beginRefresh(held)).toBe("refresh");
    expect(await b.beginRefresh((await b.get(id))!)).toBe("busy");
    // The hold runs out and B takes it over.
    a.clock.ms += 61_000;
    expect(await b.beginRefresh((await b.get(id))!)).toBe("refresh");
    held.accessToken = "access-2";
    expect(await a.store.finishRefresh(held, true)).toBe(false);
    // A session the store never loaded can't be refreshed through it.
    expect(await a.store.beginRefresh(session())).toBe("ended");
  });

  it("a save of other fields never puts back an older token", async () => {
    const { store } = keeper();
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session({ accessToken: "access-1", refreshToken: "refresh-1" }));
    const stale = (await store.get(id))!;
    const other = (await store.get(id))!;
    expect(await store.beginRefresh(other)).toBe("refresh");
    other.accessToken = "access-2";
    other.refreshToken = "refresh-2";
    expect(await store.finishRefresh(other, true)).toBe(true);
    stale.access = { ...stale.access, displayName: "Ada L." };
    await store.save(id, stale);
    expect(await store.get(id)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", access: { displayName: "Ada L." } });
  });
});

describe("the file store is for this computer only", () => {
  it("is refused anywhere deployed", () => {
    for (const environment of [{ CLOUD_ENVIRONMENT: "production" }, { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/x" }, { ECS_CONTAINER_METADATA_URI: "http://169.254.170.2/v3/x" }, { AWS_LAMBDA_FUNCTION_NAME: "f" }]) {
      expect(isDeployedEnvironment(environment)).toBe(true);
      expect(() => new LocalSessionStore(undefined, { environment })).toThrow("The file session store is for local development only");
    }
    expect(isDeployedEnvironment({})).toBe(false);
    expect(isDeployedEnvironment({ CLOUD_ENVIRONMENT: "local" })).toBe(false);
    expect(() => new LocalSessionStore(undefined, { environment: {} })).not.toThrow();
  });

  it("writes no raw cookie or token-shaped key to its file, and drops an old raw-cookie file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cloud-sessions-")), "sessions.json");
    const oldCookie = randomBytes(32).toString("base64url");
    writeFileSync(file, JSON.stringify({ [oldCookie]: session() }));
    const store = new LocalSessionStore(file, { environment: {} });
    expect(readFileSync(file, "utf8")).not.toContain(oldCookie);
    expect(await store.get(oldCookie)).toBeUndefined();
    const id = randomBytes(32).toString("base64url");
    await store.create(id, session());
    expect(readFileSync(file, "utf8")).not.toContain(id);
    expect(await new LocalSessionStore(file, { environment: {} }).get(id)).toBeDefined();
  });
});

describe("the client secret, read from Secrets Manager at run time", () => {
  const smClient = (answers: Array<() => unknown>) => {
    const sent: unknown[] = [];
    return { sent, client: { send: async (command: { input: unknown }) => { sent.push(command.input); const next = answers.shift()!; return next(); } } };
  };

  it("reads the secret by its id, keeps it for a while, and reads it again after", async () => {
    const clock = { ms: T0 };
    const { sent, client } = smClient([() => ({ SecretString: `${SECRET}\n` }), () => ({ SecretString: "rotated" })]);
    const read = secretsManagerSecret(client as never, "arn:aws:secretsmanager:us-east-1:111111111111:secret:x", { now: () => clock.ms });
    expect(await read()).toBe(SECRET);
    expect(await read()).toBe(SECRET);
    expect(sent).toEqual([{ SecretId: "arn:aws:secretsmanager:us-east-1:111111111111:secret:x" }]);
    clock.ms += 10 * 60_000;
    expect(await read()).toBe("rotated");
  });

  it("fails with fixed words, never the cause, when the secret can't be read", async () => {
    const { client } = smClient([() => { throw new Error(`AccessDenied for ${SECRET}`); }, () => ({ SecretString: "" })]);
    const read = secretsManagerSecret(client as never, "x");
    const failure = await read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClientSecretUnavailable);
    expect(String((failure as Error).message)).toBe("Rovara Cloud couldn't read its Code client secret.");
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect((failure as Error).cause).toBeUndefined();
    await expect(read()).rejects.toBeInstanceOf(ClientSecretUnavailable);
  });

  it("is sent only to Code's token endpoint, and appears in no log or error", async () => {
    const seen: string[] = [];
    const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: async () => SECRET, redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: async (input, init) => {
      seen.push(`${new URL(input instanceof Request ? input.url : input).pathname} ${JSON.stringify(init?.headers ?? {})}`);
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    } });
    const failure = await client.finishSignIn("code", { verifier: "v", returnTo: "/app", at: T0 }).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(String(failure)).not.toContain(SECRET);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/v1/auth/token");
    expect(seen[0]).toContain(Buffer.from(`rovara-cloud:${SECRET}`).toString("base64"));
  });
});

describe("the AWS adapters", () => {
  it("keeps records as SIGNIN items in Cloud's table, with consistent reads and conditional writes, and reports a lost condition as false", async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    let refuse = false;
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (refuse) throw new ConditionalCheckFailedException({ message: "no", $metadata: {} });
      return command.constructor.name === "GetCommand" ? { Item: { pk: "SIGNIN#k", sk: "SIGNIN", version: 2, createdAt: 1, lastSeenAt: 2, expiresAt: 3, sealed: "x" } } : {};
    } };
    const table = new DynamoSessionTable(client as never, "cloud");
    const record: SessionRecord = { key: "k", version: 3, createdAt: 1, lastSeenAt: 2, expiresAt: 3, sealed: "x" };
    expect(await table.get("k")).toEqual({ key: "k", version: 2, createdAt: 1, lastSeenAt: 2, expiresAt: 3, sealed: "x" });
    expect(sent[0]).toMatchObject({ name: "GetCommand", input: { TableName: "cloud", Key: { pk: "SIGNIN#k", sk: "SIGNIN" }, ConsistentRead: true } });
    expect(await table.put(record, { absent: true })).toBe(true);
    expect(sent[1]!.input).toMatchObject({ Item: { pk: "SIGNIN#k", sk: "SIGNIN", version: 3, sealed: "x" }, ConditionExpression: "attribute_not_exists(pk)" });
    expect(await table.put(record, { version: 2 })).toBe(true);
    expect(sent[2]!.input).toMatchObject({ ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": 2 } });
    refuse = true;
    expect(await table.put(record, { version: 2 })).toBe(false);
    expect(await table.touch("k", 5, 6)).toBe(false);
  });

  it("seals a sign-in under way (the PKCE verifier and where to go back), bound to its state, and takes it once", async () => {
    const items = new Map<string, Record<string, unknown>>();
    const db = { send: async (command: { constructor: { name: string }; input: { Item?: Record<string, unknown>; Key?: { pk: string } } }) => {
      if (command.constructor.name === "PutCommand") { items.set(String(command.input.Item!.pk), command.input.Item!); return {}; }
      const pk = command.input.Key!.pk;
      const old = items.get(pk);
      items.delete(pk);
      return { Attributes: old };
    } };
    const key = randomBytes(32);
    const pendingStore = new DynamoPendingSignIns(db as never, "cloud", new EnvelopeSealer(localKeyService(key)), () => T0);
    const verifier = `verifier-${randomBytes(8).toString("hex")}`;
    await pendingStore.putPending("state-1", { verifier, returnTo: "/app/projects", at: T0 });
    const stored = JSON.stringify([...items.values()]);
    expect(stored).not.toContain(verifier);
    expect(stored).not.toContain("/app/projects");
    expect(await pendingStore.takePending("state-1")).toEqual({ verifier, returnTo: "/app/projects", at: T0 });
    expect(await pendingStore.takePending("state-1")).toBeUndefined();
    // Under another key, or moved onto another state, it doesn't open.
    await pendingStore.putPending("state-2", { verifier, returnTo: "/app", at: T0 });
    const other = new DynamoPendingSignIns(db as never, "cloud", new EnvelopeSealer(localKeyService(randomBytes(32))), () => T0);
    expect(await other.takePending("state-2")).toBeUndefined();
    await pendingStore.putPending("state-3", { verifier, returnTo: "/app", at: T0 });
    items.set("PENDING#state-4", { ...items.get("PENDING#state-3")!, pk: "PENDING#state-4" });
    expect(await pendingStore.takePending("state-4")).toBeUndefined();
  });

  it("asks KMS for a data key under Cloud's key, bound to the session, and decrypts only with that key", async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GenerateDataKeyCommand" ? { Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array([1, 2, 3]) } : { Plaintext: new Uint8Array(32).fill(7), KeyId: "arn:key" };
    } };
    const sealer = new EnvelopeSealer(new KmsKeyService(client as never, "arn:key"));
    const sealed = await sealer.seal("hello", "row-1");
    expect(await sealer.open(sealed, "row-1")).toBe("hello");
    expect(sent[0]).toMatchObject({ name: "GenerateDataKeyCommand", input: { KeyId: "arn:key", KeySpec: "AES_256", EncryptionContext: { purpose: "rovara-cloud-session", session: "row-1" } } });
    expect(sent[1]).toMatchObject({ name: "DecryptCommand", input: { KeyId: "arn:key", EncryptionContext: { purpose: "rovara-cloud-session", session: "row-1" } } });
    // KMS's own refusal means the record can't be opened; throttling is passed on as it is.
    const failing = (name: string) => new KmsKeyService({ send: async () => { throw Object.assign(new Error(name), { name }); } } as never, "arn:key");
    await expect(failing("InvalidCiphertextException").unwrapDataKey(new Uint8Array(3), {})).rejects.toBeInstanceOf(SealedRecordRefused);
    await expect(failing("IncorrectKeyException").unwrapDataKey(new Uint8Array(3), {})).rejects.toBeInstanceOf(SealedRecordRefused);
    await expect(failing("ThrottlingException").unwrapDataKey(new Uint8Array(3), {})).rejects.not.toBeInstanceOf(SealedRecordRefused);
  });
});
