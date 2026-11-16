// Rovara-cloud#39: a session keeps copies of people's names (its owner and starter, its followers, its comments' authors). When a person's name
// changes, the sessions they started take the new one, so everyone reading them sees it, not only the person themselves.
import { StoreConflict, type WorkSession, type WorkSessionStore } from "./work-sessions.js";

/** The session with `developerId`'s name set to `name` wherever it is copied, or undefined when nothing changes. */
function renamed(session: WorkSession, developerId: string, name: string): WorkSession | undefined {
  let changed = false;
  const person = <P extends { developerId: string; name: string }>(entry: P): P => {
    if (entry.developerId !== developerId || entry.name === name) return entry;
    changed = true;
    return { ...entry, name };
  };
  const next: WorkSession = {
    ...session, owner: person(session.owner), startedBy: person(session.startedBy),
    ...(session.followers === undefined ? {} : { followers: session.followers.map(person) }),
    ...(session.messages === undefined ? {} : { messages: session.messages.map((message) => ({ ...message, author: person(message.author) })) }),
  };
  return changed ? next : undefined;
}

/**
 * Puts `name` on the sessions `developerId` started, wherever it is copied. A session someone wrote in between is read again once; one still in
 * conflict keeps the old name (shown to others until the next rename or sign-in). Returns how many sessions changed.
 */
export async function renameInSessions(work: WorkSessionStore, developerId: string, name: string): Promise<number> {
  if (name.trim() === "") return 0;
  let count = 0;
  for (const summary of await work.startedBy(developerId)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await work.get(summary.sessionId);
      const next = session === undefined ? undefined : renamed(session, developerId, name);
      if (next === undefined) break;
      try {
        await work.put(next);
        count += 1;
        break;
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
      }
    }
  }
  return count;
}
