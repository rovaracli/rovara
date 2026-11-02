// The nightly run on the workers (NH-1, switch `nh` with the test environment `ev`). A nightly run is a verification-mode (CHECKS) operation of a task with purpose `nightly_run`: no model, no person's words. The
// broker fixes WHAT it runs when the fire starts it (the slot, the environment revision, the branch and the commit it resolved) and sends exactly that to the worker; the worker reports back through ONE
// authenticated action, and the broker accepts a result only for those same four facts of the operation's own task.
import { z } from "zod";
import { TestEnvironmentBodySchema } from "./test-environment.js";

/** The worker feature that lists the nightly run. A nightly operation is never sent to a worker that does not list it (an older worker would run the payload's `workflowMode: "CHECKS"` as a task with no checks). */
export const NIGHTLY_RUN_FEATURE = "task.nightlyRun.v1" as const;
/** The task purpose of a nightly run. */
export const NIGHTLY_RUN_PURPOSE = "nightly_run" as const;
/** The origin of the work: the project pays for it, never a person or an agent. */
export const NIGHTLY_RUN_ORIGIN = "nightly" as const;

/** The most a nightly run may take on a worker, from the start of its operation to its result: an hour and a half of testing, with room (the design estimates 45 minutes for a repository). */
export const NIGHTLY_RUN_WALL_CLOCK_MS = 90 * 60_000;

/** What the broker fixed when the fire started the run. `headSha` is the commit the BROKER resolved for the branch; the worker refuses a workspace that holds any other. */
export const NightlyRunWireSchema = z
  .object({
    slotId: z.string().regex(/^[a-f0-9]{64}$/),
    envRevision: z.number().int().min(1),
    branch: z.string().min(1).max(250),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export type NightlyRunWire = z.infer<typeof NightlyRunWireSchema>;

/** What the worker is sent: the four facts and the APPROVED environment of that revision, read by the broker from its own record when the operation was made (never from the worker, never from the task's request). */
export const NightlyRunPayloadSchema = NightlyRunWireSchema.extend({ environment: TestEnvironmentBodySchema }).strict();
export type NightlyRunPayload = z.infer<typeof NightlyRunPayloadSchema>;

/** The body of the one worker-to-broker action: the result and, when the run recorded one, its coverage map. Both are read again by the broker's own contracts. */
export const NightlyResultCallbackBodySchema = z.object({ result: z.unknown(), coverageMap: z.unknown().optional() }).strict();
export type NightlyResultCallbackBody = z.infer<typeof NightlyResultCallbackBodySchema>;
