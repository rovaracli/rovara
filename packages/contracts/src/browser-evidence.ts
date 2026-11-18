// The Cloud copy of the setup-suggestion part of Code's `packages/contracts/src/browser-evidence.ts` (TE-H1 slice 3, mega17): what a setup run may suggest for browser evidence
// (how the app starts, on which port, and which pages which repository files make). Only this part is copied, word for word, because Cloud's setup screen reads a
// proposal that may carry it (setup-proposal.ts `browserEvidence`); the rest of Code's file (the recipe, masks, sign-in, evidence pack) is Code's alone.
// Browser-safe and pure: nothing here imports a Node module.
import { z } from "zod";
import { validPolicyPath, POLICY_PATTERN_MAX } from "./policy-glob.js";
import { redactText } from "./redaction.js";

// ---- the recipe

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
/** A path on the app's own origin: starts with `/`, no query or fragment, no `.` or `..` segment, no empty segment, at most 80 characters (it is a pair's id). */
const ROUTE_PATH = /^\/(?:[A-Za-z0-9_~\-[\]][A-Za-z0-9._~\-[\]]*(?:\/[A-Za-z0-9_~\-[\]][A-Za-z0-9._~\-[\]]*)*\/?)?$/u;
export const BROWSER_EVIDENCE_ROUTE_MAX = 80;
export function isBrowserEvidenceRoute(value: unknown): value is string {
  return typeof value === "string" && value.length <= BROWSER_EVIDENCE_ROUTE_MAX && ROUTE_PATH.test(value);
}
const RouteSchema = z.string().refine(isBrowserEvidenceRoute, "a path on the app's own origin");
const GlobSchema = z.string().refine((value) => validPolicyPath(value, POLICY_PATTERN_MAX), "a repository glob");
export const BROWSER_EVIDENCE_RECIPE_ROUTES_MAX = 50;
/** The part of a recipe the setup agent may suggest from the app's own files: how the app starts, on which port, and which pages which files make. Never a mask, a sign-in or anything secret. */
export const BrowserEvidenceSuggestionSchema = z.object({
  // A command that carries a secret-shaped value is no start command: a secret is never typed into a recipe.
  startCommand: line(500).refine((value) => redactText(value) === value, "no secret in the command"),
  port: z.number().int().min(1_024).max(65_535),
  readyPath: RouteSchema.optional(),
  framework: z.enum(["nextjs"]).optional(),
  routes: z.array(z.object({ path: RouteSchema, files: z.array(GlobSchema).min(1).max(20) }).strict()).max(BROWSER_EVIDENCE_RECIPE_ROUTES_MAX),
}).strict();
export type BrowserEvidenceSuggestion = z.infer<typeof BrowserEvidenceSuggestionSchema>;
