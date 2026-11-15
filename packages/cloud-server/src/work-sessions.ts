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
  put(session: WorkSession, requestId?: string): Promise<void>;
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

  async put(session: WorkSession, requestId?: string): Promise<void> {
    const current = this.data.sessions[session.sessionId];
    const expected = session.storeVersion;
    if (expected === undefined ? current !== undefined : (current?.storeVersion ?? 0) !== expected) throw new StoreConflict(session.sessionId);
    this.data.sessions[session.sessionId] = { ...structuredClone(session), storeVersion: (expected ?? -1) + 1 };
    if (requestId !== undefined) this.data.requests[requestId] = session.sessionId;
    this.save();
  }

  async startedBy(developerId: string): Promise<WorkSession[]> {
    return Object.values(this.data.sessions).filter((session) => session.startedBy.developerId === developerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((session) => withoutComments(this.read(session)!));
  }
}
