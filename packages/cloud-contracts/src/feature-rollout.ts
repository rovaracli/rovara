// Company rollout gates (TE-A1): an evidence feature is turned on for one company at a time, and turned back off for one company at a time.
//
// EFFECTIVE = the install's switch is exactly "1" AND the company's gate is on. The install switch stays the emergency off for everyone; a company gate off is instant for that company only. A company that
// never chose has no stored value, which reads as the catalog default (`defaultOn`): ON for the four features that already have an install switch (a missing row follows the install switch, as before the gates), OFF for the three
// named for lanes not built yet (they need a stored on). A stored value that is anything but the boolean true reads as off.
// Gates are for staging, the pilot and the rollout, and a stored false is a company's rollback. A later release flips a new feature's `defaultOn` here when it goes on for everyone (decision 116 spirit).
//
// Browser-safe (the admin screen reads the names and the shapes). The closed list of names is the only place that says which gates exist: a name outside it is refused everywhere (the route, the store).
import { z } from "zod";

/**
 * The gates, in the order the admin screen lists them. The first four front an install switch that already exists (`pe`, `vx`, `ev`, `tx`); the last three are named by the testing build plan for lanes that
 * are not built yet and have no install switch of their own (their gate is their whole switch until the lane adds one). A new gate adds its name here and to ROLLOUT_FEATURE_CATALOG in the change that builds it.
 */
export const ROLLOUT_FEATURE_NAMES = ["proofEvidence", "verifyResults", "testEnvironment", "testServices", "sealedChecks", "honestCi", "summaryCheck"] as const;
export type RolloutFeatureName = (typeof ROLLOUT_FEATURE_NAMES)[number];
export const RolloutFeatureNameSchema = z.enum(ROLLOUT_FEATURE_NAMES);

export interface RolloutFeatureCatalogEntry {
  readonly name: RolloutFeatureName;
  /** The words the admin screen's "Preview features" row shows (plain, no jargon). */
  readonly label: string;
  /** One sentence: what changes for people when it is on. */
  readonly summary: string;
  /** False while no code reads the gate yet. */
  readonly wired: boolean;
  /** What a company that never chose gets: true for the four features that already have an install switch (a missing row follows the install switch), false for a feature whose lane is not built yet. */
  readonly defaultOn: boolean;
}

export const ROLLOUT_FEATURE_CATALOG: readonly RolloutFeatureCatalogEntry[] = [
  { name: "proofEvidence", label: "Evidence for checks", summary: "Each task's checks leave evidence that is kept, shown on the task page and linked from the pull request.", wired: true, defaultOn: true },
  { name: "verifyResults", label: "Clear test results", summary: "Test results use the four plain result words on tasks and pull requests, with the Fix setup card.", wired: true, defaultOn: true },
  { name: "testEnvironment", label: "Project test setup", summary: "A project's approved test setup is used by its tasks' checks and named in the evidence.", wired: true, defaultOn: true },
  { name: "testServices", label: "Test services", summary: "Projects may use real software, fakes and fixtures as test dependencies on a sealed network.", wired: true, defaultOn: true },
  { name: "sealedChecks", label: "Sealed check rounds", summary: "Checks run in a sealed round with no outside network.", wired: false, defaultOn: false },
  { name: "honestCi", label: "Honest CI reading", summary: "The pull request evidence says what the project's CI did and did not prove.", wired: false, defaultOn: false },
  { name: "summaryCheck", label: "Rovara check on pull requests", summary: "One \"Rovara\" check on the pull request carries the evidence summary.", wired: false, defaultOn: false },
];

const KNOWN: ReadonlySet<string> = new Set(ROLLOUT_FEATURE_NAMES);
/** Whether a name is one of the gates. */
export const isRolloutFeatureName = (name: string): name is RolloutFeatureName => KNOWN.has(name);

/** What a company that never chose gets for a gate. */
export function rolloutDefaultOn(name: RolloutFeatureName): boolean {
  return ROLLOUT_FEATURE_CATALOG.find((entry) => entry.name === name)?.defaultOn === true;
}

/**
 * Whether the company's gate is on, from what is stored for it: nothing stored takes the default, exactly the boolean true is on, and anything else (false, a string, a number) is off.
 * A caller that could not read the store does not call this, and never guesses the answer from the default: a display read treats the feature as off, a path that starts or keeps work throws (RUNTIME_UNAVAILABLE) so it is retried,
 * and a gated route answers 503 (`unavailableEnv` in broker/org/feature-rollout.ts).
 */
export function rolloutGateOn(name: RolloutFeatureName, stored: unknown): boolean {
  return stored === undefined ? rolloutDefaultOn(name) : stored === true;
}

/** One gate as the admin screen reads it. `enabled` is the company's gate; `installOn` says whether the install's own switch is on, so the gate can take effect (an install with its switch off shows the row as not available). */
export const RolloutFeatureAdminRowSchema = z.object({
  name: RolloutFeatureNameSchema,
  label: z.string().max(80),
  summary: z.string().max(240),
  wired: z.boolean(),
  enabled: z.boolean(),
  installOn: z.boolean(),
}).strict();
export type RolloutFeatureAdminRow = z.infer<typeof RolloutFeatureAdminRowSchema>;

/** `GET` and `PUT /v1/app/org/feature-rollout` (owner or admin, a live browser session). `revision` is 0 while the company has never changed anything; send it back as `expectedRevision`. */
export const FeatureRolloutAnswerSchema = z.object({
  revision: z.number().int().min(0),
  features: z.array(RolloutFeatureAdminRowSchema).max(ROLLOUT_FEATURE_NAMES.length),
  changedAt: z.string().datetime().optional(),
}).strict();
export type FeatureRolloutAnswer = z.infer<typeof FeatureRolloutAnswerSchema>;

/** The change: `true` or `false` stores the company's choice for that gate; `null` removes it (back to the default). A name outside the closed list, or a body with nothing in it, is refused. */
export const FeatureRolloutBodySchema = z.object({
  expectedRevision: z.number().int().min(0).max(1_000_000_000),
  features: z.object(Object.fromEntries(ROLLOUT_FEATURE_NAMES.map((name) => [name, z.boolean().nullable().optional()])) as Record<RolloutFeatureName, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>).strict(),
}).strict().refine((body) => Object.values(body.features).some((value) => value !== undefined), { message: "nothing to change", path: ["features"] });
export type FeatureRolloutBody = z.infer<typeof FeatureRolloutBodySchema>;
