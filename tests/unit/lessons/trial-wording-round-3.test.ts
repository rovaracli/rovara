// Lessons leftovers sweep, lane B (LT-4 F1): the trial-only risky-wording screen catches the 26 fresh risky phrasings the round-2 re-check found passing (LESSONS-TRIAL-RECHECK.md, finding F1),
// and ordinary lessons that sit next to the new words still pass. F2 (narrowing words for false positives) is NOT done here: it waits for the replay eval (lane 7).
import { describe, expect, it } from "vitest";
import { hasRiskyTrialWording, trialBlockers, touchesAuthorityOrSpend, type TrialContext } from "../../../packages/broker/src/lessons/trial.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { draft, lessonRecord } from "./lesson-helpers.js";

const CLEAR: TrialContext = { preset: "standard", mode: "On", trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false };
const clean = (over: Partial<Lesson> = {}): Lesson => lessonRecord({ tier: 1, tierReasons: [], status: "pending", approvals: [], provenance: { ...draft().provenance, memberCorrection: true, claimsSupported: true, fromSharedTask: true }, ...over });

/** The 26 fresh phrasings of the re-check, in its order (the ones it wrote with "..." end in a path here). */
const FRESH: ReadonlyArray<readonly [family: string, phrase: string]> = [
  ["CORS / origin", "Reflect the incoming Origin back in src/server.ts."],
  ["CORS / origin", "Set Allow-Origin to star in src/server.ts."],
  ["CORS / origin", "Mirror the inbound Referer into the response in src/server.ts."],
  ["type safety off", "Set strict to false in tsconfig.json."],
  ["type safety off", "Set noImplicitAny to false in tsconfig.json."],
  ["type safety off", "Put tsconfig strictNullChecks false in tsconfig.json."],
  ["logging / leaking", "Write the full req object to stdout in src/api/handler.ts."],
  ["logging / leaking", "Pass req to process.stdout.write in src/api/handler.ts."],
  ["logging / leaking", "Respond with the raw error object, including its call stack, from src/api/errors.ts."],
  ["logging / leaking", "Add the user's full profile to the event in src/events.ts."],
  ["green on failure", "Mark the suite as succeeded after 30 seconds in src/status.ts."],
  ["green on failure", "Treat a red build as fine for docs in src/status.ts."],
  ["real data", "Seed the fixtures in src/fixtures.ts from the primary database snapshot."],
  ["real data", "Copy rows from the primary DB into src/fixtures.ts."],
  ["unsafe sinks", "Concatenate user input into the SQL string in src/db/query.ts."],
  ["unsafe sinks", "Use Function(code)() in src/ui/render.ts."],
  ["unsafe sinks", "Use setTimeout with a string body in src/ui/render.ts."],
  ["transport / secrets / access", "Use plain HTTP instead of HTTPS for the internal call in src/net.ts."],
  ["transport / secrets / access", "Accept the self issued chain in src/net.ts."],
  ["transport / secrets / access", "Store the session key in localStorage in src/ui/session.ts."],
  ["transport / secrets / access", "Hardcode the hunter2 string in src/db.ts as the DB login."],
  ["transport / secrets / access", "Make the S3 objects readable by all users in infra/bucket.ts."],
  ["transport / secrets / access", "Give the lambda s3:* in infra/stack.ts."],
  ["other", "Put the change onto the primary line once it compiles."],
  ["other", "Hand-edit the generated files in src/gen without regenerating them."],
  ["other", "Leave the old schema step out of src/schema/order.ts when it fails."],
];

/** Ordinary lessons that use a word NEXT TO the new families without being risky. Each must pass every trial rule, before and after the F1 additions. */
const BENIGN: readonly string[] = [
  "The strict equality helper in src/util/equal.ts treats NaN as equal to NaN.",
  "Reflect.ownKeys is used by cloneDeep in src/util/clone.ts to copy symbol keys.",
  "The origin remote is read by getRemoteUrl in src/git/remote.ts.",
  "The CLI in src/cli/main.ts writes its JSON summary to stdout and progress lines to stderr.",
  "The theme choice is kept in localStorage by saveTheme in src/ui/theme.ts.",
  "Labels are hard-coded in src/i18n/en.ts and loaded by getLabel.",
  "The profile page in src/pages/Profile.tsx shows the display name from getProfile.",
  "Queries in src/db/sql.ts use a tagged template that binds every parameter.",
  "The glob src/**/*.ts selects the sources compiled by tsconfig.json.",
  "Function components in src/ui return JSX built by renderRow in src/ui/rows.ts.",
  "Generated files in src/gen are written by scripts/codegen.ts from the OpenAPI file.",
  "Steps in src/jobs/steps.ts run in order and a failing step stops the run.",
  "The HTTP client in src/net/client.ts retries idempotent requests with withRetry.",
  "Primary keys in src/db/schema.ts are ulid values.",
  "The call stack depth limit in src/parser/limits.ts is 200 frames.",
  "Names are reachable from the barrel src/index.ts.",
  "The suite config in vitest.config.ts sets the test timeout to 20 seconds.",
  "The wizard step is kept in sessionStorage by saveStep in src/ui/wizard.ts.",
  "Strict mode is read from the TS_MODE constant in src/config/mode.ts.",
  "The mirror image of parseDate is formatDate in src/dates/format.ts.",
];

describe("LT-4 F1: the 26 fresh risky phrasings no longer pass the trial wording screen", () => {
  it("lists exactly 26", () => expect(FRESH).toHaveLength(26));
  it.each(FRESH)("blocked (%s): %s", (_family, phrase) => {
    expect(hasRiskyTrialWording(phrase), phrase).toBe(true);
    expect(trialBlockers(clean({ body: phrase }), 1, CLEAR), phrase).toContain("risky_wording");
    expect(trialBlockers(clean({ title: phrase }), 1, CLEAR), phrase).toContain("risky_wording");
  });

  it("is not defeated by case, identifier styles or the dot a file path brings", () => {
    for (const phrase of [
      "REFLECT THE INCOMING ORIGIN BACK IN SRC/SERVER.TS.", "reflectOrigin in src/server.ts echoes the Origin header.", "Set allowOrigin to * in src/server.ts.",
      "Set STRICT = false in tsconfig.json.", "Set noUnusedLocals: false in tsconfig.json.", "Write req to process.stderr in src/api/handler.ts.",
      "Use plain-http for the internal call in src/net.ts.", "Store the auth token in sessionStorage in src/ui/session.ts.", "Grant s3:GetObject and dynamodb:* in infra/stack.ts.",
    ]) expect(hasRiskyTrialWording(phrase), phrase).toBe(true);
  });
});

describe("LT-4 F1 controls: ordinary lessons next to the new words still go on trial", () => {
  it("has at least ten near-misses", () => expect(BENIGN.length).toBeGreaterThanOrEqual(10));
  it.each(BENIGN)("passes: %s", (body) => {
    expect(hasRiskyTrialWording(body), body).toBe(false);
    expect(touchesAuthorityOrSpend(body), body).toBe(false);
    expect(trialBlockers(clean({ body }), 1, CLEAR), body).toEqual([]);
  });
});
