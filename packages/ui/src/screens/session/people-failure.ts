import { ApiError } from "../../api/errors.js";

/** What the People panel says about a failed request. Server error words are NEVER shown; only these fixed sentences are. */
export interface PeopleFailure { text: string; /** The server's fixed machine code (for example PROJECT_ACCESS_DENIED), shown only as a "Ref" detail for support. */ ref?: string }
export type PeopleFailureKind = "read" | "candidates" | "write" | "remove";

/**
 * The action layer (task-action.ts, session-safety.ts) raises status-0 errors of its own; none of them is a connection problem.
 * Each gets its own fixed sentence. A write whose outcome is unknown says to CHECK before acting again, never to try again.
 */
const CLIENT_SENTENCES: Record<string, string> = {
 REQUEST_UNCONFIRMED: "Rovara didn't confirm this change yet. Check who is on this task before changing it again.",
 PERSISTENCE_UNAVAILABLE: "Rovara can't safely make this change from this browser right now. Check who is on this task before changing it again.",
 ACTION_CLAIM_UNAVAILABLE: "This change wasn't sent from this tab. Another tab may be changing this task. Check who is on this task, then try again.",
 READ_REQUIRED: "Check who is on this task before changing it.",
 READ_SUPERSEDED: "Check who is on this task before changing it.",
 READ_FAILED: "Check who is on this task before changing it.",
 IDENTITY_CHANGED: "Your sign-in changed. Check this page again before changing who is on this task.",
};
/** Errors this panel raised itself with its own fixed words (a stale list, a change waiting for confirmation): the only ApiErrors whose message may be read. */
const ownWords = new WeakSet<ApiError>();
export function panelError(status: number, code: string, message: string): ApiError {
 const error = new ApiError(status, code, message);
 ownWords.add(error);
 return error;
}

const SIGNED_OUT = new Set(["AUTH_REQUIRED", "SESSION_EXPIRED"]);
const DENIED = new Set(["PROJECT_ACCESS_DENIED", "TASK_ACCESS_DENIED", "ACCESS_DENIED", "ACCESS_ENDED", "ACCESS_LOST", "FORBIDDEN", "IDENTITY_CHANGED"]);
const NOT_FOUND = new Set(["NOT_FOUND", "SESSION_NOT_FOUND", "TASK_NOT_FOUND", "PROJECT_NOT_FOUND"]);

const FALLBACK: Record<PeopleFailureKind, string> = {
 read: "Couldn't load who is on this task. Try again in a moment.",
 candidates: "Couldn't load the people you can add. Try again in a moment.",
 write: "Couldn't change who is on this task. Try again.",
 remove: "Couldn't remove this person. Try again.",
};
const ACTION: Record<PeopleFailureKind, string> = { read: "see who is on this task", candidates: "add people to this task", write: "change who is on this task", remove: "remove this person" };

/** Maps a failed People request to plain words: 401 sign in again, 403 access not confirmed, 404 not found, 409 changed, anything else (5xx, network) the neutral line. */
export function peopleFailure(error: unknown, kind: PeopleFailureKind): PeopleFailure {
 if (!(error instanceof ApiError)) return { text: FALLBACK[kind] };
 if (ownWords.has(error)) return { text: error.message };
 const code = error.code.toUpperCase();
 // REQUEST_FAILED is the client's stand-in for an unreadable body: no meaning for support, so no Ref.
 const ref = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) && error.code !== "REQUEST_FAILED" ? error.code : undefined;
 const out = (text: string): PeopleFailure => ref === undefined ? { text } : { text, ref };
 // Only the client's own NETWORK_ERROR means the connection failed; the action layer's status-0 codes have their own sentences.
 if (error.status === 0 && Object.hasOwn(CLIENT_SENTENCES, error.code)) return { text: CLIENT_SENTENCES[error.code]!, ref: error.code };
 // A dropped connection during a write means the change may or may not have gone through: check, never "try again".
 if (error.code === "NETWORK_ERROR" && (kind === "write" || kind === "remove")) return { text: CLIENT_SENTENCES["REQUEST_UNCONFIRMED"]! };
 if (error.code === "NETWORK_ERROR") return { text: "Couldn't reach Rovara. Check your connection and try again." };
 if (error.status === 401 || SIGNED_OUT.has(code)) return out("Sign in again to " + ACTION[kind] + ".");
 if (error.status === 403 || DENIED.has(code)) return out(kind === "read" || kind === "candidates" ? "Rovara couldn't confirm your access to this task's people." : "Rovara couldn't confirm you can " + ACTION[kind] + ".");
 if (error.status === 404 || NOT_FOUND.has(code)) return out("This task wasn't found, or you no longer have access.");
 if (error.status === 409 && (kind === "write" || kind === "remove")) return out("Who is on this task changed. Check the list, then try again.");
 return out(FALLBACK[kind]);
}
