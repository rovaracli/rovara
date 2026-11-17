// Cloud's sessions (PrepLabsAI/Rovara-cloud#1, phase 2): a session is Cloud's own record of a piece of work, with its
// `ses_…` id, who started it and (later) its followers, shares and messages. It points at the Rovara Code task doing
// the work; Code keeps the task. The store is an interface so a deployed Cloud keeps sessions in its own table
// (dynamo-stores.ts).
//
// Several servers can share one store (PrepLabsAI/Rovara-cloud#11). A session read carries the store's version
// (`storeVersion`), and `put` writes it only if nobody wrote it since: otherwise it throws StoreConflict, and the handler
// runs the request again on the fresh session. A route never loses another request's change.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export interface WorkSession {
  sessionId: string;
  /** The Rovara Code task doing the work. */
  taskId: string;
  project: string;
  /** Who started it: their Code developer id and name. */
  startedBy: { developerId: string; name: string };
  /** Who owns it now: the starter, until someone takes it over. */
  owner: { developerId: string; name: string };
  createdAt: string;
  /**
   * The company the session was started in (DEC 253z), from Code's access check of its starter. Every read through a company's view
   * (companyScopedWork) checks it. A session written before companies were stamped has none (see companyScopedWork).
   */
  companyId?: string;
  /**
   * Set on a session made by opening a task someone else started: Code's task view has no owner field, so `owner` (and `startedBy`) hold the
   * owner's name from Code's People read and a placeholder id (a hash of Code's person id that matches no sign-in) until the owner opens the task.
   * Never set on a session a person started.
   */
  ownerUnresolved?: true;
  /** What a change to the session (a take-over) is asked against; it goes up with each change Cloud makes. */
  revision: number;
  /** People who follow the session (phase 2c); the owner always follows and is never listed. */
  followers?: Array<{ developerId: string; name: string }>;
  /** The session's comments between people (Rovara-cloud#24): Cloud's own, oldest first. */
  messages?: SessionComment[];
  /** Each comment's request ID, so a retried send answers the same comment. */
  messageRequests?: Record<string, string>;
  /** The store's version of this session as it was read; the store keeps it. A session without one is new. */
  storeVersion?: number;
}

/** A new session for a person Code names no company for: never written (companyScopedWork). */
export class SessionCompanyMissing extends Error {
  constructor() {
    super("a new session needs the person's company");
  }
}

/** The session changed since it was read (or a new one already exists): run the request again on the fresh session. */
export class StoreConflict extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} changed since it was read`);
  }
}

/** A comment as Cloud stores it (SessionMessageSchema, kind `comment`, source `app`). */
export interface SessionComment {
  messageId: string;
  kind: "comment";
  source: "app";
  author: { developerId: string; name: string };
  text: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  rev: number;
  /** A reply holds the id of the first message of its thread. */
  threadId?: string;
}

/** A new message id in the app's format (`msg_` and 20 lower-case letters and digits). */
export function newMessageId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return `msg_${[...randomBytes(20)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export interface WorkSessionStore {
  get(sessionId: string): Promise<WorkSession | undefined>;
  /** The session a start request made, so a retried start answers the same session. */
  byRequest(requestId: string): Promise<WorkSession | undefined>;
  /**
   * Writes the session: a new one (no `storeVersion`) only if its id is free, a read one only if nobody wrote it since.
   * Otherwise throws StoreConflict and writes nothing. With `requestId`, the start request that made it.
   */
  put(session: WorkSession, requestId?: string, options?: { once?: boolean }): Promise<void>;
  /**
   * The session of a Code task, whoever made it: each new session also records its task, so opening a task by its id finds the session. With
   * `put`'s `once`, a new session whose task already has one writes nothing and throws StoreConflict, so two openers get the same session.
   */
  byTask(taskId: string): Promise<WorkSession | undefined>;
  /** The sessions a person started, newest first, without their comments (`messages`, `messageRequests`). */
  startedBy(developerId: string): Promise<WorkSession[]>;
}

/** The session without its comments, as `startedBy` answers it. */
export function withoutComments(session: WorkSession): WorkSession {
  const copy = { ...session };
  delete copy.messages;
  delete copy.messageRequests;
  return copy;
}

/** The request key a task's session is recorded under: a request id is a UUID, so this never collides with one. */
export const taskRequestKey = (taskId: string): string => `task-${taskId}`;

/** A new session id in Cloud's format (`ses_` and 20 lower-case letters and digits). */
export function newSessionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return `ses_${[...randomBytes(20)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

interface Stored { sessions: Record<string, WorkSession>; requests: Record<string, string> }

/** Sessions in memory; with `file`, also written to that private file (mode 600) so a restart keeps them. */
export class LocalWorkSessionStore implements WorkSessionStore {
  private readonly data: Stored;

  constructor(private readonly file?: string) {
    this.data = { sessions: {}, requests: {} };
    if (file === undefined) return;
    try {
      const loaded = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
      Object.assign(this.data.sessions, loaded.sessions ?? {});
      Object.assign(this.data.requests, loaded.requests ?? {});
    } catch { /* a new file */ }
  }

  private save(): void {
    if (this.file !== undefined) writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  /** A copy with its version: two requests in this server between awaits are two writers too. */
  private read(session: WorkSession | undefined): WorkSession | undefined {
    return session === undefined ? undefined : { ...structuredClone(session), storeVersion: session.storeVersion ?? 0 };
  }

  async get(sessionId: string): Promise<WorkSession | undefined> {
    return this.read(this.data.sessions[sessionId]);
  }

  async byRequest(requestId: string): Promise<WorkSession | undefined> {
    const sessionId = this.data.requests[requestId];
    return sessionId === undefined ? undefined : this.read(this.data.sessions[sessionId]);
  }

  async put(session: WorkSession, requestId?: string, options?: { once?: boolean }): Promise<void> {
    const current = this.data.sessions[session.sessionId];
    const expected = session.storeVersion;
    if (expected === undefined ? current !== undefined : (current?.storeVersion ?? 0) !== expected) throw new StoreConflict(session.sessionId);
    if (expected === undefined && options?.once === true && this.data.requests[taskRequestKey(session.taskId)] !== undefined) throw new StoreConflict(session.sessionId);
    this.data.sessions[session.sessionId] = { ...structuredClone(session), storeVersion: (expected ?? -1) + 1 };
    if (requestId !== undefined) this.data.requests[requestId] = session.sessionId;
    if (expected === undefined) this.data.requests[taskRequestKey(session.taskId)] = session.sessionId;
    this.save();
  }

  async byTask(taskId: string): Promise<WorkSession | undefined> {
    return this.byRequest(taskRequestKey(taskId));
  }

  async startedBy(developerId: string): Promise<WorkSession[]> {
    return Object.values(this.data.sessions).filter((session) => session.startedBy.developerId === developerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((session) => withoutComments(this.read(session)!));
  }

  /** Everything this store holds, for moving it to another (#11): each session as new (no `storeVersion`), and the start requests. */
  everything(): { sessions: WorkSession[]; requests: Record<string, string> } {
    const sessions = Object.values(this.data.sessions).map((session) => {
      const copy = structuredClone(session);
      delete copy.storeVersion;
      return copy;
    });
    return { sessions, requests: { ...this.data.requests } };
  }
}

/**
 * One company's view of the sessions (DEC 253z: Cloud's own records keyed by person carry the company and are checked on every read). The
 * company is read from `companyOf()` at each call, so a route that refreshed the person's access check uses the fresh answer.
 * - A stamped session of another company (or any stamped session, when the person has no company) reads as absent: the same answer as
 *   a session that doesn't exist.
 * - A new session is stamped with the company.
 * - A new session is never written without a company: the write throws SessionCompanyMissing (the route that starts work refuses a person
 *   with no company before that, so this only backs it up).
 * - A session written before stamping (no `companyId`) stays readable, as before: every route that shows or changes one asks Code for its
 *   task first, and Code's own company check refuses another company's task. All of them were written in the founders' company (DEC 254).
 */
export function companyScopedWork(store: WorkSessionStore, companyOf: () => string | undefined): WorkSessionStore {
  const visible = (session: WorkSession | undefined): WorkSession | undefined => {
    if (session === undefined) return undefined;
    if (session.companyId === undefined) return session;
    const companyId = companyOf();
    return companyId !== undefined && session.companyId === companyId ? session : undefined;
  };
  return {
    get: async (sessionId) => visible(await store.get(sessionId)),
    byRequest: async (requestId) => visible(await store.byRequest(requestId)),
    byTask: async (taskId) => visible(await store.byTask(taskId)),
    put: async (session, requestId, options) => {
      const companyId = companyOf();
      if (session.companyId !== undefined && session.companyId !== companyId) throw new StoreConflict(session.sessionId);
      let stamped = session;
      if (session.storeVersion === undefined && session.companyId === undefined) {
        if (companyId === undefined) throw new SessionCompanyMissing();
        stamped = { ...session, companyId };
      }
      await store.put(stamped, requestId, options);
    },
    startedBy: async (developerId) => (await store.startedBy(developerId)).filter((session) => visible(session) !== undefined),
  };
}
