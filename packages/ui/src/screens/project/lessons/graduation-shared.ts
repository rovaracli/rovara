// Shared bits of the phase 4 lesson cards (L4-LP4G): Code's own refusal words, shown as they came, and the query keys a write refreshes.
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { INBOX_KEY, learnedKey } from "../../../api/learned.js";

export const failureWords = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);
/** A write Code refused because what the person saw is out of date (gone, or changed by someone else): the cards are read again, and Code's own sentence stays on screen. */
export function refreshIfStale(error: unknown, query: QueryClient, project: string) {
  if (error instanceof ApiError && (error.status === 404 || error.status === 409 || error.status === 412)) refreshLessons(query, project);
}
/** A write came through: every lessons list, this week's cards and the inbox are read again. */
export function refreshLessons(query: QueryClient, project: string) {
  void query.invalidateQueries({ queryKey: learnedKey(project) });
  void query.invalidateQueries({ queryKey: INBOX_KEY });
}
