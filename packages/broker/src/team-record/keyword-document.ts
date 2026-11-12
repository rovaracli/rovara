// What the keyword side reads of a row (DECISIONS 145). One definition for the live scan (query.ts) and the keyword index (keyword-index.ts), so the two score the same words.
import type { StoredEvent } from "./store.js";

/**
 * What the keyword side scores of a row: its text (only while the text has not expired: the words of expired raw text are never scored, even when a night's text-expiry job has not removed them yet) and its structured
 * fields. A row read through `eventFromItem` has already lost an expired text; the check here keeps that true for a row from any other reader.
 */
export function keywordDocumentOf(event: StoredEvent, nowSeconds: number): string {
  const text = event.text !== undefined && (event.textExpiresAt === undefined || event.textExpiresAt > nowSeconds) ? event.text : "";
  return `${text} ${JSON.stringify(event.structured ?? {})}`;
}

/** The same row once its text is gone: only the structured fields (what the row scores from the moment its raw text expires). */
export function structuredDocumentOf(event: StoredEvent): string {
  return ` ${JSON.stringify(event.structured ?? {})}`;
}
