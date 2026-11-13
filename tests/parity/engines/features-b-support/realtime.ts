// Realtime (area 40): the change notices each path tells an open page, by notice type. Cloud: the person's changes feed rows (`CHANGE_NOTICE`, written
// before each publish; the journey harness has no events API, so nothing is posted, but the feed holds exactly what would be). Core: what the core
// published on the `realtime` point (Code's in-process publisher in the local composition; A8's AppSync publisher is the Cloud adapter of that point).
import { outcome } from "./outcomes.js";

export function realtimeWords(types: readonly string[]): string[] {
  return [...new Set(types)].sort().map((type) => outcome("realtime", type));
}
