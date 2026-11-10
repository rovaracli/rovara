// Lane 7 (DECISIONS 50.5, 68): the FILE arm of the replay. A local agent is offered the pipeline's lessons the way lane R2 offers them to a team: as the repository file `.rovara/lessons.md` (R2's own format and
// renderer: `renderLesson`, `renderLessonsFile`) with the one pointer line in AGENTS.md (`withPointer`). The BROKER renders it at a replay copy's dispatch, from the copy's frozen snapshot, and sends it to the worker as
// extra files valid only for a replay copy (`aws/broker/lessons-dispatch.ts`); the worker places them in the copy's checkout and keeps them out of any diff. A lesson R2 would not put in a file (no text, a scope that is
// not plain tokens, a scope naming only other repositories) is not offered, exactly as for a team. The MCP arm is not built.
import { LESSON_FILE_PATH } from "@agentx/contracts";
import { renderLessonsFile } from "./repo-file-format.js";
import { renderLesson } from "./repo-file-plan.js";
import { withPointer } from "./repo-file-pointer.js";
import { lessonContentKey } from "./replay-lessonset.js";
import type { Lesson } from "./types.js";

export interface ReplayLessonsFiles {
  /** The files to place in the checkout: the lessons file, and the agent file with the one pointer line. */
  files: Array<{ path: string; content: string }>;
  /** The content keys of the lessons the file holds: what the local agent is offered. */
  keys: string[];
}

/** The lessons file and pointer for a snapshot's lessons and a repository, or undefined when there is nothing to offer. `agentsFile` is the checkout's own AGENTS.md text when it has one (the worker adds the pointer to it). */
export function replayLessonsFiles(lessons: readonly Lesson[], repository: string, agentsFile?: string): ReplayLessonsFiles | undefined {
  const rendered = lessons.filter((lesson) => lesson.status === "active").flatMap((lesson) => { const r = renderLesson(lesson, repository); return r === undefined ? [] : [{ lesson, r }]; });
  if (rendered.length === 0) return undefined;
  const content = renderLessonsFile(rendered.map(({ r }) => ({ id: r.id, heading: r.heading, text: r.text })));
  const pointed = withPointer("AGENTS.md", agentsFile);
  return { files: [{ path: LESSON_FILE_PATH, content }, ...(pointed === undefined ? [] : [{ path: "AGENTS.md", content: pointed }])], keys: rendered.map(({ lesson }) => lessonContentKey(lesson)) };
}
