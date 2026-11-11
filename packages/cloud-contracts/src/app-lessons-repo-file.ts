// Lessons in the repo, lane R2 (owner decisions 50, 50a, 50b; LESSONS-REPO-FILE-DESIGN.md rev 2 sections 5 and 9): what the Lessons tab (Cloud), the API and the CLI (`lessons repo status|on|off|resume`) read and send for the
// Rovara-owned `.rovara/lessons.md` and its weekly batched pull request.
// Browser-safe: nothing here imports a Node module. Request bodies are strict; the answer has a forward reader. Every text is a FIXED sentence chosen by a code: no lesson text, no person and no host text ever rides here.
import { z } from "zod";
import { forwardReader, LESSON_FILE_POINTER_STATES, LESSON_FILE_PROBLEMS, LESSON_FILE_WAITING_FOR, LessonsRepoFilePrSchema } from "@rovara-code/contracts";

export const LessonsRepoFileRowSchema = z.object({
  /** The project's name for the repository. */
  repo: z.string().min(1).max(200),
  enabled: z.boolean(),
  /** The team deleted the file: Rovara stopped until someone resumes it. */
  fileDeleted: z.boolean(),
  /** Pull requests in a row that nobody merged; at 3, new lessons and edits are paused. */
  unmerged: z.number().int().min(0),
  additionsPaused: z.boolean(),
  /** Removals waiting in the open pull request. */
  removalsWaiting: z.number().int().min(0),
  /** Lessons the team edited in the file: Rovara leaves them exactly as written. */
  held: z.number().int().min(0),
  pointer: z.enum(LESSON_FILE_POINTER_STATES),
  /** Pull requests that remove deleted lessons (opened by the erasure sweep) and are waiting for the team to merge. */
  erasurePrs: z.number().int().min(0).optional(),
  /** Present on a switched-on repository while lessons are off: the choice is recorded and the file starts when lessons are switched on for the installation or for the project. The text is `LESSON_FILE_WAITING_TEXT`. */
  waitingFor: z.enum(LESSON_FILE_WAITING_FOR).optional(),
  pr: LessonsRepoFilePrSchema.optional(),
  lastPassAt: z.number().optional(),
  problem: z.enum(LESSON_FILE_PROBLEMS).optional(),
  /**
   * Present only while a person is asked to confirm retiring lessons that went missing from the file in one change (more than a few at once, held a week first; owner decision 78): how many, since when (the first time this set
   * was seen) and the digest the person's answer must carry back. Absent: nothing waits for a decision.
   */
  retireConfirm: z.object({ missing: z.number().int().min(1), since: z.number(), digest: z.string().regex(/^[0-9a-f]{16}$/u) }).strict().optional(),
  /** The fixed sentences to show for this row, in order (the same lines the pull request body and the CLI print). */
  notices: z.array(z.string().max(300)).max(10),
}).strict();
export type LessonsRepoFileRow = z.infer<typeof LessonsRepoFileRowSchema>;
export const LessonsRepoFileRowReaderSchema = forwardReader(LessonsRepoFileRowSchema);

export const LessonsRepoFileStatusSchema = z.object({
  /** Lessons are switched off or not allowed to load for this project: no pull request is opened while that holds. */
  lessonsOff: z.boolean(),
  /** True when the code host of at least one repository can write, so the switch can be offered. */
  canEnable: z.boolean(),
  repos: z.array(LessonsRepoFileRowSchema).max(100),
  /** Whether the caller may answer for lessons missing from a file (the company owner, or a person who can approve lessons here): the card with Retire and Keep shows only then. Absent: no. Computed only while a row asks. */
  canDecideRetire: z.boolean().optional(),
  /** Repositories Rovara cannot reach (the app is uninstalled, the repository is gone or was removed from the project) while deleted lessons may still be in them: recorded once, tried again weekly. */
  unreachable: z.array(z.object({ repo: z.string().min(1).max(200), lessons: z.number().int().min(0) }).strict()).max(100).optional(),
  /** Open Rovara pull requests that were NOT closed (or taken down) because the code host could not show them or did not say Rovara made them: counted, tried again. */
  closesHeld: z.array(z.object({ repo: z.string().min(1).max(200), count: z.number().int().min(1) }).strict()).max(100).optional(),
  /** Branches Rovara made that the code host cannot match to a pull request, so Rovara cannot check them for deleted lessons. */
  strayBranches: z.array(z.object({ repo: z.string().min(1).max(200), branches: z.number().int().min(1) }).strict()).max(100).optional(),
  /** The repositories of the project with no row yet (not switched on), so a person can pick them. */
  available: z.array(z.string().min(1).max(200)).max(100),
}).strict();
export type LessonsRepoFileStatus = z.infer<typeof LessonsRepoFileStatusSchema>;
export const LessonsRepoFileStatusReaderSchema = forwardReader(LessonsRepoFileStatusSchema);

/**
 * What a maintainer sends: switch a repository on or off, resume it after the team deleted the file, or answer the pointer. `pointers` are the agent files the person ticked (default: the ones Rovara finds).
 * `retire_confirm` and `retire_keep` answer the card for lessons that went missing from the file (owner decision 78; the company owner or a person who can approve lessons): they carry `held`, the digest of the row's `retireConfirm`.
 */
export const LESSON_FILE_ACTIONS = ["on", "off", "resume", "pointer_add", "pointer_decline", "retire_confirm", "retire_keep"] as const;
export const LessonsRepoFileBodySchema = z.object({
  action: z.enum(LESSON_FILE_ACTIONS),
  repo: z.string().min(1).max(200),
  pointers: z.array(z.enum(["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"])).max(3).optional(),
  /** The digest of the missing set the person saw (`retireConfirm.digest`): required for `retire_confirm` and `retire_keep`, refused for anything else. */
  held: z.string().regex(/^[0-9a-f]{16}$/u).optional(),
}).strict().superRefine((body, context) => {
  const retire = body.action === "retire_confirm" || body.action === "retire_keep";
  if (retire && body.held === undefined) context.addIssue({ code: "custom", path: ["held"], message: "held is required for this action" });
  if (!retire && body.held !== undefined) context.addIssue({ code: "custom", path: ["held"], message: "held is only for retire_confirm and retire_keep" });
});
export type LessonsRepoFileBody = z.infer<typeof LessonsRepoFileBodySchema>;
