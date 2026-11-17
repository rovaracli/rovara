// A person's Cloud session: their Code tokens stay on the server, the browser holds only an opaque cookie.
// Stored logins (migration plan v3.2, 7.2 change 4): a record per login under a hash of the cookie, never the cookie;
// sealed (session-crypto.ts); an idle and an absolute limit; a refreshed token saved before the call is retried, under a
// conditional write, so two servers refreshing at once neither both win nor lose the session. Deployed, the table is
// DynamoDB and the sealer is KMS; on this computer, LocalSessionStore keeps them in memory or a private file.
import { createHash, randomBytes } from "node:crypto";
import type { CodeAccess, PendingSignIn } from "./code-client.js";
import { PLAIN_LOCAL_SEALER, SealedRecordRefused, type TokenSealer } from "./session-crypto.js";
import { LocalSessionTable, type SessionRecord, type SessionTable } from "./session-table.js";

export interface CodeSession {
  accessToken: string;
  refreshToken?: string;
  access: CodeAccess;
  /** Sent back by the app on every change (x-rovara-csrf), as Cloud's own sessions do. */
  csrf: string;
  signedInAt: string;
  /** Onboarding creations by requestId, so a retried request answers the same project. */
  created?: Record<string, { name: string; at: string; /** Guided onboarding PR 10: a digest of the body, and for separate projects each repository's outcome (project-create-routes.ts). */ digest?: string; results?: Array<{ repository: string; outcome: string; project?: string; reason?: string }> }>;
  /** Set when a route changed the session (its name, its creations), so it is saved after the request. */
  changed?: boolean;
}

/** How a refresh may go ahead (CodeClient.useRefreshGuard). */
export interface RefreshGuard {
  /**
   * Before asking Code: "refresh" (this server holds the refresh), "refreshed" (another server already refreshed; the
   * session now carries its tokens), "ended" (the login is gone), "busy" (another server's refresh did not finish in time).
   */
  beginRefresh(session: CodeSession): Promise<"refresh" | "refreshed" | "ended" | "busy">;
  /** After Code answered: saves the new tokens (ok) or ends the login (not ok). False when the session could not be kept. */
  finishRefresh(session: CodeSession, ok: boolean): Promise<boolean>;
  /** The refresh failed before Code answered (no tokens changed): lets the next caller try, keeping the login. */
  abandonRefresh(session: CodeSession): Promise<void>;
}

/** Sign-ins under way, by their state. */
export interface PendingSignIns {
  putPending(state: string, pending: PendingSignIn): Promise<void>;
  takePending(state: string): Promise<PendingSignIn | undefined>;
}

export interface SessionStore extends RefreshGuard {
  /** The session for a cookie, or undefined when there is none or it passed a limit. */
  get(id: string): Promise<CodeSession | undefined>;
  /** Keeps a new session under a new cookie. */
  create(id: string, session: CodeSession): Promise<void>;
  /** Saves a route's changes (name, creations); never puts back older tokens. */
  save(id: string, session: CodeSession): Promise<void>;
  delete(id: string): Promise<void>;
  /** A sign-in under way, by its state, for at most ten minutes. */
  putPending(state: string, pending: PendingSignIn): Promise<void>;
  /** Takes a pending sign-in: it can be used once. */
  takePending(state: string): Promise<PendingSignIn | undefined>;
}

/** A login unused this long ends. */
export const SESSION_IDLE_MS = 12 * 60 * 60_000;
/** A login ends this long after sign-in however often it is used. */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
/** The idle clock is written at most this often. */
const TOUCH_MS = 60_000;
/** How long one server's refresh holds the others off. */
const REFRESH_LEASE_MS = 60_000;
const SAVE_ATTEMPTS = 5;

/** The record key for a cookie: its SHA-256. The cookie is 32 random bytes, so the hash can't be turned back. */
export function sessionKey(cookie: string): string {
  return createHash("sha256").update(`rovara-cloud-session:${cookie}`).digest("base64url");
}

export interface SessionKeeperOptions {
  table: SessionTable;
  sealer: TokenSealer;
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
  log?: (event: Record<string, unknown>) => void;
  /** How long to wait between looks while another server refreshes, and how many looks. */
  refreshWaitMs?: number;
  refreshWaitLooks?: number;
  /** Where sign-ins under way are kept; this server's memory by default. */
  pending?: PendingSignIns;
}

interface Loaded { key: string; lease?: string }
type Stored = Omit<CodeSession, "changed">;

const isStored = (value: unknown): value is Stored => {
  const v = value as Partial<Stored> | null;
  return typeof v === "object" && v !== null && typeof v.accessToken === "string" && typeof v.csrf === "string" && typeof v.signedInAt === "string"
    && (v.refreshToken === undefined || typeof v.refreshToken === "string") && typeof v.access === "object" && v.access !== null;
};

function memoryPending(): PendingSignIns {
  const pending = new Map<string, PendingSignIn>();
  return {
    async putPending(state, value) { pending.set(state, value); },
    async takePending(state) {
      const value = pending.get(state);
      pending.delete(state);
      return value;
    },
  };
}

export class SessionKeeper implements SessionStore {
  private readonly table: SessionTable;
  private readonly sealer: TokenSealer;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly waitMs: number;
  private readonly waitLooks: number;
  private readonly loaded = new WeakMap<CodeSession, Loaded>();
  private readonly pendingSignIns: PendingSignIns;

  constructor(options: SessionKeeperOptions) {
    this.table = options.table;
    this.sealer = options.sealer;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS;
    this.absoluteMs = options.absoluteMs ?? SESSION_ABSOLUTE_MS;
    this.log = options.log ?? ((event) => { console.log(JSON.stringify(event)); });
    this.waitMs = options.refreshWaitMs ?? 200;
    this.waitLooks = options.refreshWaitLooks ?? 100;
    this.pendingSignIns = options.pending ?? memoryPending();
  }

  private expiresAt(createdAt: number, lastSeenAt: number): number {
    return Math.ceil(Math.min(lastSeenAt + this.idleMs, createdAt + this.absoluteMs) / 1000);
  }

  private async seal(key: string, session: Stored): Promise<string> {
    const stored: Stored & { changed?: boolean } = { ...session };
    delete stored.changed;
    return this.sealer.seal(JSON.stringify(stored), key);
  }

  /** Opens a record; undefined (and the record removed) when it can't be opened. */
  private async open(record: SessionRecord): Promise<Stored | undefined> {
    try {
      const parsed: unknown = JSON.parse(await this.sealer.open(record.sealed, record.key));
      if (isStored(parsed)) return parsed;
    } catch (error) {
      // Another key, another row, or damaged: falls through. Anything else (KMS throttled, the network) keeps the record.
      if (!(error instanceof SealedRecordRefused) && !(error instanceof SyntaxError)) throw error;
    }
    this.log({ event: "cloud.session_unreadable" });
    await this.table.delete(record.key);
    return undefined;
  }

  /** The record if it is within both limits; otherwise removed. */
  private async live(key: string): Promise<SessionRecord | undefined> {
    const record = await this.table.get(key);
    if (record === undefined) return undefined;
    const now = this.now();
    const limit = now > record.createdAt + this.absoluteMs ? "absolute" : now > record.lastSeenAt + this.idleMs ? "idle" : undefined;
    if (limit === undefined) return record;
    await this.table.delete(key);
    this.log({ event: "cloud.session_expired", limit });
    return undefined;
  }

  async get(id: string): Promise<CodeSession | undefined> {
    const key = sessionKey(id);
    const record = await this.live(key);
    if (record === undefined) return undefined;
    const stored = await this.open(record);
    if (stored === undefined) return undefined;
    const now = this.now();
    if (now - record.lastSeenAt >= TOUCH_MS) await this.table.touch(key, now, this.expiresAt(record.createdAt, now));
    const session: CodeSession = { ...stored };
    this.loaded.set(session, { key });
    return session;
  }

  async create(id: string, session: CodeSession): Promise<void> {
    const key = sessionKey(id);
    const now = this.now();
    const record: SessionRecord = { key, version: 1, createdAt: now, lastSeenAt: now, expiresAt: this.expiresAt(now, now), sealed: await this.seal(key, session) };
    if (!await this.table.put(record, { absent: true })) throw new Error("a session with this cookie already exists");
    this.loaded.set(session, { key });
  }

  async save(id: string, session: CodeSession): Promise<void> {
    const key = sessionKey(id);
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      const record = await this.live(key);
      if (record === undefined) return;
      const latest = await this.open(record);
      if (latest === undefined) return;
      // Only what a route changes; the tokens are the stored ones, which only a refresh writes.
      const merged: Stored = { ...latest, access: session.access, ...(session.created === undefined ? {} : { created: session.created }) };
      if (await this.table.put({ ...record, version: record.version + 1, sealed: await this.seal(key, merged) }, { version: record.version })) return;
    }
    throw new Error("the session kept changing while it was saved");
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(sessionKey(id));
  }

  async beginRefresh(session: CodeSession): Promise<"refresh" | "refreshed" | "ended" | "busy"> {
    const loaded = this.loaded.get(session);
    if (loaded === undefined) return "ended";
    for (let look = 0; look < this.waitLooks; look += 1) {
      const record = await this.live(loaded.key);
      if (record === undefined) return "ended";
      const latest = await this.open(record);
      if (latest === undefined) return "ended";
      if (latest.accessToken !== session.accessToken) {
        session.accessToken = latest.accessToken;
        if (latest.refreshToken === undefined) delete session.refreshToken;
        else session.refreshToken = latest.refreshToken;
        return "refreshed";
      }
      if (record.refreshingUntil !== undefined && record.refreshingUntil > this.now()) {
        await new Promise((resolve) => setTimeout(resolve, this.waitMs));
        continue;
      }
      const lease = randomBytes(16).toString("base64url");
      if (await this.table.put({ ...record, version: record.version + 1, refreshingUntil: this.now() + REFRESH_LEASE_MS, refreshLease: lease }, { version: record.version })) {
        loaded.lease = lease;
        return "refresh";
      }
    }
    return "busy";
  }

  async finishRefresh(session: CodeSession, ok: boolean): Promise<boolean> {
    const loaded = this.loaded.get(session);
    const lease = loaded?.lease;
    if (loaded === undefined || lease === undefined) return false;
    delete loaded.lease;
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      const record = await this.live(loaded.key);
      if (record === undefined) return false;
      // Another server took over after this one's hold ran out: keep the session only if it holds these same tokens.
      if (record.refreshLease !== lease) {
        const latest = await this.open(record);
        return ok && latest?.accessToken === session.accessToken;
      }
      if (!ok) {
        await this.table.delete(loaded.key);
        return false;
      }
      const latest = await this.open(record);
      if (latest === undefined) return false;
      const merged: Stored = { ...latest, accessToken: session.accessToken };
      if (session.refreshToken === undefined) delete merged.refreshToken;
      else merged.refreshToken = session.refreshToken;
      const next: SessionRecord = { ...record, version: record.version + 1, sealed: await this.seal(loaded.key, merged) };
      delete next.refreshingUntil;
      delete next.refreshLease;
      if (await this.table.put(next, { version: record.version })) return true;
    }
    return false;
  }

  async abandonRefresh(session: CodeSession): Promise<void> {
    const loaded = this.loaded.get(session);
    const lease = loaded?.lease;
    if (loaded === undefined || lease === undefined) return;
    delete loaded.lease;
    const record = await this.table.get(loaded.key);
    if (record?.refreshLease !== lease) return;
    const next: SessionRecord = { ...record, version: record.version + 1 };
    delete next.refreshingUntil;
    delete next.refreshLease;
    await this.table.put(next, { version: record.version });
  }

  async putPending(state: string, pending: PendingSignIn): Promise<void> {
    await this.pendingSignIns.putPending(state, pending);
  }

  async takePending(state: string): Promise<PendingSignIn | undefined> {
    return this.pendingSignIns.takePending(state);
  }
}

/**
 * True anywhere Cloud is deployed: a named environment (CLOUD_ENVIRONMENT, set by infra/lib/cloud-app.ts), any ECS task, or
 * a Lambda. Only an unset CLOUD_ENVIRONMENT or "local" with none of the others is this computer.
 */
export function isDeployedEnvironment(environment: Record<string, string | undefined>): boolean {
  const named = environment.CLOUD_ENVIRONMENT;
  return (named !== undefined && named !== "" && named !== "local")
    || Boolean(environment.ECS_CONTAINER_METADATA_URI_V4) || Boolean(environment.ECS_CONTAINER_METADATA_URI) || Boolean(environment.AWS_LAMBDA_FUNCTION_NAME);
}

export interface LocalSessionStoreOptions {
  /** The environment checked for a deployed Cloud; process.env by default. */
  environment?: Record<string, string | undefined>;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

/** Sessions in memory; with `file`, also in that private file so a restart keeps people signed in. This computer only. */
export class LocalSessionStore extends SessionKeeper {
  constructor(file?: string, options: LocalSessionStoreOptions = {}) {
    super(LocalSessionStore.checked(file, options));
  }

  private static checked(file: string | undefined, options: LocalSessionStoreOptions): SessionKeeperOptions {
    if (isDeployedEnvironment(options.environment ?? process.env)) {
      throw new Error("The file session store is for local development only; a deployed Cloud keeps sign-ins in its table (CLOUD_SESSIONS_TABLE).");
    }
    return { table: new LocalSessionTable(file), sealer: PLAIN_LOCAL_SEALER, ...(options.now ? { now: options.now } : {}), ...(options.log ? { log: options.log } : {}) };
  }
}
