// UX-4b: lessons waiting for a person become a Home card, as suggested rules do (`learning/home-source.ts`). One card per project, for a person who may decide that project's lessons, saying how
// many wait for them and linking to the project's Lessons tab. The count is the Lessons tab's own (`buildLessonsView`): only lessons the person can see and decide, so a lesson from a source they
// can't see is never counted. Bounded: at most LESSON_HOME_PROJECTS_MAX projects the person maintains, read at once inside Home's source time. Nothing is written. The reader is plugged in at
// handler start where the team record and lessons are on (`setLessonsHomeReader`); without it the source makes no card.
import { createHash } from "node:crypto";
import { lessonsPauseText, projectAllows, type OrgId } from "@agentx/contracts";
import { fit, quoted, registerHomeCardSource, type HomeCardSource, type HomeSourceCard } from "../agent-sessions/home.js";

export const LESSON_HOME_PROJECTS_MAX = 10;

/**
 * How many lessons of a project wait for this person's OK (0 when none, when they can't decide there, or when learning is off), and since when; and, for a person who decides there, why learning is paused
 * for the project (lane 1b: never silent), as a fixed code and a time.
 */
export type LessonsHomeReader = (orgId: OrgId, developerId: string, project: string) => Promise<{ waiting: number; at?: string | undefined; paused?: { code: string; at: number } | undefined }>;

let reader: LessonsHomeReader | undefined;
export function setLessonsHomeReader(next: LessonsHomeReader | undefined): void { reader = next; }

const hashOf = (orgId: string, project: string): string => `lw_${createHash("sha256").update(`${orgId}\n${project}`, "utf8").digest("hex").slice(0, 24)}`;

export const lessonsHomeSource: HomeCardSource = {
  kind: "lesson_waiting",
  async list(deps, caller): Promise<HomeSourceCard[]> {
    const read = reader, members = deps.approvals?.projectMembers;
    if (read === undefined || members === undefined) return [];
    const { orgId } = caller;
    const maintained = (await members.projectsOf(orgId, { developerId: caller.developerId, orgRole: caller.orgRole }))
      .filter((entry) => projectAllows(entry.role, "edit_settings")).map((entry) => entry.project).sort().slice(0, LESSON_HOME_PROJECTS_MAX);
    const origin = deps.origin.replace(/\/+$/u, "");
    const counted = await Promise.all(maintained.map(async (project) => ({ project, ...(await read(orgId, caller.developerId, project).catch((): { waiting: number; at?: string; paused?: { code: string; at: number } } => ({ waiting: 0 }))) })));
    return counted.filter((entry) => entry.waiting > 0 || entry.paused !== undefined).map(({ project, waiting, at, paused }) => {
      const pausedLine = paused === undefined ? undefined : lessonsPauseText(paused.code);
      const waitingLine = waiting > 0 ? `${String(waiting)} ${waiting === 1 ? "lesson waits" : "lessons wait"} for a maintainer's OK in ${quoted(project)}` : undefined;
      return {
        cardId: `lesson_waiting:${hashOf(orgId, project)}`, kind: "lesson_waiting" as const,
        title: waitingLine === undefined ? `Lessons paused in ${quoted(project)}` : `Lessons waiting in ${quoted(project)}`,
        reason: fit([waitingLine, pausedLine].filter((line): line is string => line !== undefined).join(". "), ""),
        at: at ?? (paused === undefined ? new Date(deps.now()).toISOString() : new Date(paused.at).toISOString()),
        buttons: [{ label: waitingLine === undefined ? "Open" : "Review", action: "open" as const, href: `${origin}/app/projects/${encodeURIComponent(project)}?tab=lessons`, method: "GET" as const }],
      };
    });
  },
};

registerHomeCardSource(lessonsHomeSource);
