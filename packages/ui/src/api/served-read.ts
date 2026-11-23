/** Internal read policy (DEC 254zzz324). Retained facts never grant write authority. */
const accessCodes = new Set([
 "AUTH_REQUIRED", "SESSION_EXPIRED", "ACCESS_ENDED", "ACCESS_LOST", "ACCESS_DENIED",
 "FORBIDDEN", "NOT_FOUND", "SESSION_NOT_FOUND", "PROJECT_NOT_FOUND", "TASK_ACCESS_DENIED", "IDENTITY_CHANGED",
]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
/** Read the access signal even when the rest of an error envelope is unreadable. */
export function accessEndedCode(value: unknown): string | undefined {
 if (!object(value)) return undefined;
 const nested = object(value["error"]) ? value["error"] : undefined;
 for (const code of [nested?.["code"], value["code"]]) {
  if (typeof code !== "string") continue;
  const normalized = code.toUpperCase().replaceAll("-", "_");
  if (accessCodes.has(normalized)) return normalized;
 }
 return undefined;
}
export function isAccessEnded(error: unknown): boolean {
 return object(error) && ((typeof error["status"] === "number" && [401, 403, 404].includes(error["status"])) || accessEndedCode(error) !== undefined);
}
/**
 * A 404 for ONE page or skill (not for the whole scope): the read marks it, so the person sees a local "not found" and the rest of the Wiki / Skills stays usable.
 * It is still an access signal for the page's own facts (they are wiped, nothing private stays on screen); a 401 / 403 or any other access word is never marked.
 */
const localMissing = new WeakSet<object>();
export function markLocalMissing(error: unknown): void { if (object(error) && error["status"] === 404 && accessEndedCode(error) !== "PROJECT_NOT_FOUND") localMissing.add(error); }
export function isLocalMissing(error: unknown): boolean { return object(error) && localMissing.has(error); }
/** The timestamp belongs to the kept success, never to a failed refresh. No earlier data means no stale state. */
export function servedReadState<T>(read: { data: T | undefined; dataUpdatedAt: number; isError: boolean; error: unknown; failureCount?: number; failureReason?: unknown }): { data: T | undefined; staleSince: number | undefined } {
 const failed = read.isError || (read.failureCount ?? 0) > 0;
 if (failed && (isAccessEnded(read.error) || isAccessEnded(read.failureReason))) return { data: undefined, staleSince: undefined };
 return { data: read.data, staleSince: failed && read.data !== undefined ? read.dataUpdatedAt : undefined };
}
