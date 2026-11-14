// Who is looking at a session now (PrepLabsAI/Rovara-cloud#1, phase 2c): each open session page sends a heartbeat
// (PRESENCE_HEARTBEAT_SECONDS, 30s), and a person counts as viewing for 90 seconds after their last one. Kept in this
// server's memory: a deployed Cloud with more than one server needs a shared store behind the same interface.

/** How long a heartbeat counts (PRESENCE_TTL_SECONDS in the contracts). */
export const PRESENCE_TTL_MS = 90_000;
/** The most viewers a session lists (PRESENCE_VIEWERS_MAX in the contracts). */
export const PRESENCE_VIEWERS_MAX = 20;

export interface Viewer { developerId: string; name: string }

export interface PresenceBoard {
  /** Records the person's heartbeat on the session and answers who is viewing it now, them included. */
  heartbeat(sessionId: string, person: Viewer, nowMs: number): Viewer[];
  viewing(sessionId: string, nowMs: number): Viewer[];
}

export class LocalPresenceBoard implements PresenceBoard {
  private readonly seen = new Map<string, Map<string, { name: string; at: number }>>();

  heartbeat(sessionId: string, person: Viewer, nowMs: number): Viewer[] {
    const here = this.seen.get(sessionId) ?? new Map<string, { name: string; at: number }>();
    here.set(person.developerId, { name: person.name, at: nowMs });
    this.seen.set(sessionId, here);
    return this.viewing(sessionId, nowMs);
  }

  viewing(sessionId: string, nowMs: number): Viewer[] {
    const here = this.seen.get(sessionId);
    if (here === undefined) return [];
    for (const [developerId, entry] of here) if (nowMs - entry.at >= PRESENCE_TTL_MS) here.delete(developerId);
    if (here.size === 0) this.seen.delete(sessionId);
    return [...here.entries()].sort(([, a], [, b]) => b.at - a.at).slice(0, PRESENCE_VIEWERS_MAX).map(([developerId, entry]) => ({ developerId, name: entry.name }));
  }
}
