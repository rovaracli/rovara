// Guided onboarding PR 17 (DEC 254n item 3): the fixed words Cloud answers for a project's archive and restore, and the one summary read the
// project page uses to decide which control to show. Code decides who may archive or restore (PrepLabsAI/Rovara #839); Cloud only passes the
// person's own token and turns Code's answer into these sentences, so nothing Code or the browser sent is ever echoed.
import { z } from "zod";

export const PROJECT_LIFECYCLE_WORDS = Object.freeze({
  notFound: "project not found",
  notAllowed: "Only company owners and admins, or this project's admins, can archive or restore it.",
  invalid: "the request is not valid",
  stale: "The project changed. Review it again before you archive or restore it.",
  notOnEngine: "Archiving isn't available for this company yet: its tasks don't run on the engine that stops work on an archived project.",
  notYet: "Archiving isn't available yet.",
  unavailable: "The project's state couldn't be checked just now. Try again.",
});
/** Every sentence a lifecycle refusal may carry: the app shows one of these, or its own words, never anything else. */
export const PROJECT_LIFECYCLE_SENTENCES: ReadonlySet<string> = new Set(Object.values(PROJECT_LIFECYCLE_WORDS));

/** `GET /v1/app/projects/{p}/lifecycle`: the project's archive state and what the person may do now, from Code's own previews. */
export const AppProjectLifecycleSchema = z.object({
  status: z.enum(["active", "archived"]),
  actions: z.array(z.enum(["archive", "restore"])).max(1),
}).strict();
export type AppProjectLifecycle = z.infer<typeof AppProjectLifecycleSchema>;
