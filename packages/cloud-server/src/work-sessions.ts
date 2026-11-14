// Cloud's sessions (PrepLabsAI/Rovara-cloud#1, phase 2): a session is Cloud's own record of a piece of work, with its
// `ses_…` id, who started it and (later) its followers, shares and messages. It points at the Rovara Code task doing
// the work; Code keeps the task. The store is an interface so a deployed Cloud keeps sessions in its own table.
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
}

export interface WorkSessionStore {
  get(sessionId: string): Promise<WorkSession | undefined>;
  /** The session a start request made, so a retried start answers the same session. */
  byRequest(requestId: string): Promise<WorkSession | undefined>;
  put(session: WorkSession, requestId?: string): Promise<void>;
  /** The sessions a person started, newest first. */
  startedBy(developerId: string): Promise<WorkSession[]>;
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

  async get(sessionId: string): Promise<WorkSession | undefined> {
    return this.data.sessions[sessionId];
  }

  async byRequest(requestId: string): Promise<WorkSession | undefined> {
    const sessionId = this.data.requests[requestId];
    return sessionId === undefined ? undefined : this.data.sessions[sessionId];
  }

  async put(session: WorkSession, requestId?: string): Promise<void> {
    this.data.sessions[session.sessionId] = session;
    if (requestId !== undefined) this.data.requests[requestId] = session.sessionId;
    this.save();
  }

  async startedBy(developerId: string): Promise<WorkSession[]> {
    return Object.values(this.data.sessions).filter((session) => session.startedBy.developerId === developerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
