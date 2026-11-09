// Lane 7 (DECISIONS 50.5): the FILE arm of the replay. A local agent is offered the pipeline's lessons the way lane R2 offers them to a team: as the repository file `.rovara/lessons.md` (R2's own format and
// renderer: `renderLesson`, `renderLessonsFile`) with the one pointer line in AGENTS.md (`withPointer`). This module only renders; the executor's install side places the file and the pointer in the checkout.
// Lessons that R2 would not put in a file (no text, a scope that is not plain tokens, a scope naming only other repositories) are not offered, exactly as for a team. The MCP arm stays a stub.
import { LESSON_FILE_PATH } from "@agentx/contracts";
import { renderLessonsFile } from "./repo-file-format.js";
import { renderLesson } from "./repo-file-plan.js";
import type { LessonDelivery, LessonsFileOffer } from "./replay-harness.js";
import { lessonContentKey } from "./replay-lessonset.js";
import type { Lesson } from "./types.js";

export const FILE_DELIVERY: LessonDelivery = {
  kind: "file",
  built: true,
  render(lessons: readonly Lesson[], repository: string): LessonsFileOffer {
    const rendered = lessons.filter((lesson) => lesson.status === "active").flatMap((lesson) => { const r = renderLesson(lesson, repository); return r === undefined ? [] : [{ lesson, r }]; });
    return {
      path: LESSON_FILE_PATH, pointerPath: "AGENTS.md", keys: rendered.map(({ lesson }) => lessonContentKey(lesson)),
      content: renderLessonsFile(rendered.map(({ r }) => ({ id: r.id, heading: r.heading, text: r.text }))),
    };
  },
};
