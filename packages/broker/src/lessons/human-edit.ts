// Lessons capture lane: the human-edit extractor (owner decision Q5, 2026-10-30: "do not store diffs"). When a person pushed to a Rovara pull request and it merged, the code-host tap
// (team-record/sources/codehost.ts `runHumanEdit`) proves who wrote the commits and hands the changed lines over ONCE, in memory (`HumanEditInput`). This turns them into lesson drafts and drops them.
// What is kept is only the lessons the reflector makes and a link to the pull request (the lesson's `pr` citation); the diff, the hunks and the file names of the edit are not stored anywhere.
//
//  - Behind the learning switch, like every reflection (`resolveLearning`): Off and Collect read nothing and call no model.
//  - Every author is checked NOW: a canonical developer id that is no longer a member of the project, or is erased, means nothing is learned (the lines of one file are not attributed to one person, so
//    a lesson cannot keep an erased person's work out while keeping the rest). The lesson names every author, so erasing any one of them deletes it (owner decision: co-written lessons are purged). A check that cannot tell THROWS, so the job is retried and never treated as "not erased".
//  - The model call is the reflector's: it goes through the customer-pays `PipelineModel` and the company's learning spend (lane 1), tool-less.
//  - The task's own facts (intent, plan, who started and steered it) come from the same source as the task-end reflection; the task's send-backs, findings and close reason are that reflection's.
//  - A model error THROWS (the tap gives the claim back and the queue retries). A spend refusal, an ineligible task or a reply with no lesson is a quiet "0 candidates".
import type { HumanEditExtractorPort, HumanEditInput, HumanEditJob } from "../team-record/sources/codehost.js";
import { currentLearningAttempt } from "./learning-deadline.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { processDraft, type ProcessDeps } from "./process.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { EvidenceSpan, ReflectSubject } from "./reflect-input.js";
import type { LearnResult, TaskSubjectSource } from "./task-end.js";
import { buildTaskReflectSubject } from "./task-subject.js";

export interface HumanEditExtractorDeps {
  source: TaskSubjectSource;
  settings: LearningSettingsReader;
  reflect: ReflectDeps;
  process: ProcessDeps;
  /** The person's standing in the project right now (`learning/standing.ts readStanding`). */
  standing(orgId: string, developerId: string, project: string): Promise<"member" | "outsider">;
  /** Whether the person is erased (the record's marker or the lessons fence). THROWS when it cannot tell. */
  isErased(orgId: string, developerId: string, project: string): Promise<boolean>;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The most authors of one edit that are learned from. */
export const MAX_EDIT_AUTHORS = 5;

/** The kinds of the task's own spans a human edit's reflection keeps for context. */
const CONTEXT_KINDS: ReadonlySet<string> = new Set(["intent", "plan"]);

/** One changed file as one span of words the model can read: the place, the symbols the hunk headers named, and the changed lines (already bounded and redacted by the tap). */
function editSpan(file: HumanEditInput["files"][number], input: Pick<HumanEditInput, "authors" | "audience" | "scope">): EvidenceSpan {
  const symbols = file.symbols.length === 0 ? "" : ` (${file.symbols.join(", ")})`;
  return {
    kind: "human_edit", trust: "member", sourceKey: "human_edit",
    // A lesson built from these lines names every person who wrote any of them (a file's lines are not attributed to one person), so the erase of any one of them deletes it. The lines come from the
    // repository: they carry its audience and scope, so who may read the lesson is decided by access to that repository, as for a comment on it.
    ...(input.authors.length === 1 ? { authorId: input.authors[0]! } : {}), authorIds: input.authors, audience: input.audience, scopes: [input.scope],
    text: `A person changed ${file.path}${symbols}, +${String(file.additions)} -${String(file.deletions)}:\n${file.hunks.join("\n")}`,
  };
}

export function createHumanEditExtractor(deps: HumanEditExtractorDeps): HumanEditExtractorPort {
  return {
    async extract(input) {
      const none = { candidates: 0 };
      if (input.authors.length === 0 || input.files.length === 0) return none;
      // A lesson names every author and a provenance list holds 20 names: an edit by a crowd is not learned from (no name is ever cut).
      if (input.authors.length > MAX_EDIT_AUTHORS) return none;
      const learning = await resolveLearning(deps.settings, input.workspaceId, input.project);
      if (!modeAllows(learning.mode, "reflect")) return none;
      const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId, context: "human_edit" });
      if (base === undefined || base.facts.workspaceId !== input.workspaceId || base.facts.project !== input.project || base.facts.taskId !== input.taskId) return none;
      // Every author, now. Asking all of them (no short cut) so a check that cannot tell is never hidden by an earlier answer.
      let allowed = true;
      for (const developerId of input.authors) {
        const erased = await deps.isErased(input.workspaceId, developerId, input.project);
        const standing = erased ? "outsider" : await deps.standing(input.workspaceId, developerId, input.project);
        if (erased || standing !== "member") allowed = false;
      }
      if (!allowed) return none;
      const context = (base.facts.rest.spans ?? []).filter((span) => CONTEXT_KINDS.has(span.kind));
      const links = [...new Set([...(base.facts.rest.links ?? []), input.link])];
      const subject: ReflectSubject = buildTaskReflectSubject({
        ...base.facts, sendBacks: [],
        rest: { ...base.facts.rest, links, spans: [...context, ...input.files.map((file) => editSpan(file, input))] },
      });
      // A lesson from an edit must stand on the edit: a candidate that cites no edit span is dropped (the people named come from everything read, but the lesson is about the lines).
      const result = await reflectSubject(deps.reflect, { ...subject, requireEvidenceKind: "human_edit" });
      if (result.reason === "model_error" || (result.reason === "spend_refused" && currentLearningAttempt()?.fault === "retryable")) throw new Error("the model call failed");
      if (result.status !== "ok") return none;
      const key = { workspaceId: input.workspaceId, project: input.project };
      let kept = 0;
      const signal = currentLearningAttempt()?.signal;
      for (const draft of result.drafts) {
        // At the deadline no new draft is started (the lesson store refuses its writes too). The model was paid for; what is cut is lost, never repeated.
        if (signal?.aborted === true) { deps.log?.("learning.drafts_cut_at_deadline", { taskId: input.taskId }); break; }
        try { await processDraft(deps.process, key, draft); kept += 1; } catch { deps.log?.("learning.draft_failed", { taskId: input.taskId }); }
      }
      return { candidates: kept };
    },
  };
}

export interface HumanEditWorkDeps {
  /** The Team record's `humanEdit.run(job, { leased: true })`: proves the authors, reads the compare live and hands it to the extractor once. */
  run(job: HumanEditJob): Promise<"handed_on" | "skipped">;
  settings: LearningSettingsReader;
}

/**
 * What the LessonsWorker runs for a human-edit message, inside the reflection's lease and attempt (`reflect-worker.ts`). The learning switch comes first, from the project alone, so a project whose learning is Off or
 * Collect never has its host read. It never throws: a fault before any model call (a read, the compare, an identity or erasure check) is `retry`, which the lease takes again only while no call has started; a fault the model
 * path marked `final` (a call that may have been billed) is not. The money rules are the reflection's: the model path writes the lease's `callStartedAt` before the call, so a redelivery after a started call is never run again.
 */
export async function learnFromHumanEdit(deps: HumanEditWorkDeps, job: HumanEditJob): Promise<LearnResult> {
  const attempt = currentLearningAttempt();
  if (attempt !== undefined) delete attempt.fault;
  try {
    const learning = await resolveLearning(deps.settings, job.repo.workspaceId, job.project);
    if (!modeAllows(learning.mode, "reflect")) return { status: "off", retry: false };
    const handed = await deps.run(job);
    return { status: handed === "handed_on" ? "reflected" : "no_facts", retry: false };
  } catch {
    return { status: "not_reflected", retry: currentLearningAttempt() !== undefined && currentLearningAttempt()?.fault !== "final" };
  }
}
