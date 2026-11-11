// Moving a session between a Mac and the cloud (Plan 5 Task 19): the two bodies of `POST /v1/app/sessions/{id}/handoff`, what a move to a Mac answers, and the exact texts of its refusals.
// One session and one link run across the moves; each stretch on one place is a leg (`SessionLegSchema`).
import { z } from "zod";
import { DeviceIdSchema, GitBranchNameSchema, HANDOFF_SUMMARY_MAX_BYTES } from "@rovara-code/contracts";

const utf8 = new TextEncoder();

/** `owner/name`, as a project registers a repository's address. */
export const HANDOFF_REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
/** A commit id. */
export const HandoffShaSchema = z.string().regex(/^[a-f0-9]{40}$/, "must be a 40-character commit id in lower case");

/** Where the work stands, in words: 1 to `HANDOFF_SUMMARY_MAX_BYTES` UTF-8 bytes (a longer one is refused, never cut). */
const SummarySchema = z.string().refine((value) => value.trim() !== "", "must say where the work stands")
  .refine((value) => utf8.encode(value).length <= HANDOFF_SUMMARY_MAX_BYTES, `must be at most ${String(HANDOFF_SUMMARY_MAX_BYTES)} bytes`);

/** From a session on a Mac: the branch the Mac pushed, its head, and a summary of where the work stands. */
export const HandoffToCloudBodySchema = z
  .object({
    requestId: z.string().uuid(),
    to: z.literal("cloud"),
    repository: z.string().regex(HANDOFF_REPOSITORY_PATTERN, "must look like owner/name"),
    branch: GitBranchNameSchema,
    headSha: HandoffShaSchema,
    summary: SummarySchema,
  })
  .strict();
export type HandoffToCloudBody = z.infer<typeof HandoffToCloudBodySchema>;

/** From a cloud task session: the Mac (a device of the caller's) that carries on. */
export const HandoffToMacBodySchema = z.object({ requestId: z.string().uuid(), to: z.literal("mac"), deviceId: DeviceIdSchema }).strict();
export type HandoffToMacBody = z.infer<typeof HandoffToMacBodySchema>;

export const HandoffBodySchema = z.discriminatedUnion("to", [HandoffToCloudBodySchema, HandoffToMacBodySchema]);
export type HandoffBody = z.infer<typeof HandoffBodySchema>;

/** What a move to a Mac answers: where the work was pushed, and where it stands. */
export const HandoffToMacAnswerSchema = z
  .object({ repository: z.string().min(1), branch: GitBranchNameSchema, headSha: HandoffShaSchema, summary: z.string().min(1) })
  .strict();
export type HandoffToMacAnswer = z.infer<typeof HandoffToMacAnswerSchema>;

// ---- what a refusal says (codes: FORBIDDEN, CONFIG_INVALID, RUNTIME_UNAVAILABLE and the session codes; the texts are exact)

/** FORBIDDEN: only the owner moves a session. */
export function handoffOwnerOnlyMessage(owner: string): string {
  return `Only ${owner} can move this session.`;
}
/** CONFIG_INVALID: the repository named is not one of the session's project. */
export function handoffRepositoryMessage(repository: string, project: string): string {
  return `${repository} isn't part of ${project}.`;
}
/** RUNTIME_UNAVAILABLE: Plan 6's `HandoffRuntime` is not supplied. */
export const HANDOFF_NOT_READY_MESSAGE = "Moving a session between a Mac and the cloud isn't ready yet.";
/** CONFIG_INVALID: a chain run has no Mac leg. */
export const HANDOFF_CHAIN_MESSAGE = "A chain run stays in the cloud.";
/** CONFIG_INVALID: an agent-step run has no branch to carry to a Mac. */
export const HANDOFF_AGENT_RUN_MESSAGE = "An agent run stays in the cloud.";
/** CONFIG_INVALID: the session is where the move would put it. */
export const HANDOFF_ALREADY_CLOUD_MESSAGE = "This session is already in the cloud.";
export const HANDOFF_ALREADY_MAC_MESSAGE = "This session is already on a Mac.";
/** CONFIG_INVALID: a session with no project has nothing to start a cloud task on. */
export const HANDOFF_NO_PROJECT_MESSAGE = "This session isn't on a project, so it can't move to the cloud.";
/** CONFIG_INVALID: the 20th move is the last (`SESSION_LEGS_MAX`). */
export const HANDOFF_TOO_MANY_LEGS_MESSAGE = "This session has moved as often as it can.";
/** FORBIDDEN: the owner's project role must be able to start work for a cloud leg. */
export function handoffStartWorkMessage(project: string): string {
  return `You need a role on ${project} that can start work to move this to the cloud.`;
}
/** PROJECT_ACCESS_DENIED: the owner lost their role on the project before moving to a Mac. */
export function handoffRoleLostMessage(project: string): string {
  return `You no longer have a role on ${project}, so this session can't move to your Mac.`;
}
/** RUNTIME_UNAVAILABLE: the budget could not be checked, so no paid work starts. */
export const HANDOFF_BUDGET_UNAVAILABLE_MESSAGE = "Rovara couldn't check the budget just now. Try again in a moment.";
/** RUNTIME_UNAVAILABLE: cloud work starts only after the owner's budget has been checked. */
export const HANDOFF_BUDGET_NOT_CHECKED_MESSAGE = "Moving a session to the cloud isn't available right now.";
/** RUNTIME_UNAVAILABLE: another move of the session holds the claim (it is given up after a few minutes). */
export const HANDOFF_MOVING_MESSAGE = "This session is being moved right now. Try again in a minute.";
/** RUNTIME_UNAVAILABLE: a move that did not finish and left nothing changed. */
export const HANDOFF_BUSY_MESSAGE = "This session is busy right now. Try again.";
/** RUNTIME_UNAVAILABLE: the cloud answered with something a move can't use. */
export const HANDOFF_BAD_ANSWER_MESSAGE = "The move could not be completed right now. Try again in a moment.";
/** SESSION_REVISION_CONFLICT is `SESSION_REVISION_CONFLICT_MESSAGE`; this one is for the session that changed while a move was under way. */
export const HANDOFF_CHANGED_MESSAGE = "This session changed while it was being moved. Reload it and try again.";
