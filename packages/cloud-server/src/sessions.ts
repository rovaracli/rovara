// A person's Cloud session: their Code tokens stay on the server, the browser holds only an opaque cookie. The store is
// an interface so a deployed Cloud keeps sessions in its own table; locally they live in memory or a private file.
import { readFileSync, writeFileSync } from "node:fs";
import type { CodeAccess, PendingSignIn } from "./code-client.js";

export interface CodeSession {
  accessToken: string;
  refreshToken?: string;
  access: CodeAccess;
  /** Sent back by the app on every change (x-rovara-csrf), as Cloud's own sessions do. */
  csrf: string;
  signedInAt: string;
  /** Onboarding creations by requestId, so a retried request answers the same project. */
  created?: Record<string, { name: string; at: string }>;
  /** Set when a refresh changed the tokens, so the session is saved after the request. */
  changed?: boolean;
}

export interface SessionStore {
  get(id: string): Promise<CodeSession | undefined>;
  put(id: string, session: CodeSession): Promise<void>;
  delete(id: string): Promise<void>;
  /** A sign-in under way, by its state, for at most ten minutes. */
  putPending(state: string, pending: PendingSignIn): Promise<void>;
  /** Takes a pending sign-in: it can be used once. */
  takePending(state: string): Promise<PendingSignIn | undefined>;
}

/** Sessions in memory; with `file`, also written to that private file so a restart keeps people signed in. */
export class LocalSessionStore implements SessionStore {
  private readonly sessions: Map<string, CodeSession>;
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(private readonly file?: string) {
    this.sessions = new Map(file === undefined ? [] : LocalSessionStore.load(file));
  }

  private static load(file: string): Array<[string, CodeSession]> {
    try {
      return Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, CodeSession>);
    } catch {
      return [];
    }
  }

  private save(): void {
    if (this.file === undefined) return;
    const stored = Object.fromEntries([...this.sessions].map(([id, session]) => {
      const copy = { ...session };
      delete copy.changed;
      return [id, copy];
    }));
    writeFileSync(this.file, JSON.stringify(stored), { mode: 0o600 });
  }

  async get(id: string): Promise<CodeSession | undefined> {
    return this.sessions.get(id);
  }

  async put(id: string, session: CodeSession): Promise<void> {
    // The request's `changed` mark is not part of the sign-in (as in DynamoSessionStore).
    const stored = { ...session };
    delete stored.changed;
    this.sessions.set(id, stored);
    this.save();
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    this.save();
  }

  async putPending(state: string, pending: PendingSignIn): Promise<void> {
    this.pending.set(state, pending);
  }

  async takePending(state: string): Promise<PendingSignIn | undefined> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    return pending;
  }
}
