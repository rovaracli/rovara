import { createHash, timingSafeEqual } from "node:crypto";
export const APP_CSRF_HEADER = "x-rovara-csrf";
export function appCsrfTokenFor(sessionCookie: string): string { return createHash("sha256").update("rovara-app-csrf:" + sessionCookie, "utf8").digest("base64url"); }
export function appCsrfMatches(sessionCookie: string, supplied: string | undefined): boolean {
 if (supplied === undefined) return false;
 const expected = Buffer.from(appCsrfTokenFor(sessionCookie), "utf8"), actual = Buffer.from(supplied, "utf8");
 return actual.length === expected.length && timingSafeEqual(actual, expected);
}
