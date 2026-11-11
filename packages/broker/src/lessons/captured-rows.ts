// Lessons capture lane: what a finished task's lessons can learn from the people's own words that the Team record already holds, read by the rows' deterministic source ids (the record core's
// source index), never by a scan:
//   - a "remember this" note: the `rovara.remembered` row `task:<task>:note:<note id>` (the words of the comment's author);
//   - a human reviewer's comment or review on one of the task's pull requests: the code-host tap's `github.review_comment` / `github.review` row
//     `<repository>#pr<number>:<review_comment|discussion|review><id>` (team-record/sources/codehost.ts writes them; there is no second hook beside it).
// A row that is missing, belongs to another workspace, project or task, is hidden (an erased person's rows are deleted and tombstoned; a comment deleted at its source is tombstoned), has no text
// (retention A), or was written by anyone but a person who was a company member when they wrote it (a bot, an outsider) gives nothing. The caller reads the person's standing and erasure NOW:
// what is written down here is only who the row names and the words. Internal reads: the audience of the lesson is the subject's and the span's, set by the caller.
import type { RecordEvent } from "@agentx/cloud-contracts";
import { bySource, eventFromItem } from "../team-record/store.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { PullRequestSurface } from "../team-record/sources/capture-adapters.js";
import type { Audience } from "./types.js";

/** What the caller needs of one captured row of a person's words. */
export interface CapturedWords {
  /** The row's source id: the id a lesson cites. */
  id: string;
  /** The canonical developer id of the person the row names. */
  authorDeveloperId: string;
  text: string;
  audience: Audience;
  /** The place the row came from (a repository, a project), for the access check at read time. */
  scope: string;
  /** The account id the row's author has on the code host (the row's source id), for the checks made on the host's own account (exclusion). */
  authorSourceId: string;
  /** The record's name of the place's source (`github`, `codehost:<name>`). */
  source: string;
  /**
   * Whether the text the agent was shown is this author's own: no other person has a row on the comment, the host does not record an edit of it, and the comment was shown exactly as first written
   * (`shownAt` is not later than when it was first written). A change by an unlinked, excluded or since-erased person leaves no row, so the rows alone cannot prove it: a REVIEW body is proved only when the
   * host said at collection that it was never edited (`edited === false`: anyone with write access may edit another person's review, and nothing else would show it); a comment is refused when the host said
   * it was edited, and otherwise needs the time check. False when `shownAt` is not given (comments).
   */
  ownText: boolean;
  /** The inline comment's file, the line it was made on and the commit it was made on, when the host said them. */
  path?: string | undefined;
  line?: number | undefined;
  commitId?: string | undefined;
  /** Which side of the diff `line` is numbered on (`LEFT`: the base file; `RIGHT`: the file at `commitId`), when the host said. */
  side?: "LEFT" | "RIGHT" | undefined;
}

export type { PullRequestSurface };

export interface CapturedRowReader {
  /** The "remember this" note of one correction (the note id is the correction's id). */
  rememberedNote(input: { workspaceId: string; project: string; taskId: string; noteId: string }): Promise<CapturedWords | undefined>;
  /** One comment or review of a pull request, as its author first wrote it. `shownAt`: when the host last changed the comment, as the agent was shown it (epoch milliseconds); `edited`: whether the host recorded an edit of it at collection (absent: not said). Both for `ownText`. */
  pullRequestWords(input: { workspaceId: string; project: string; host: string; repository: string; number: number; surface: PullRequestSurface; commentId: string; shownAt?: number; edited?: boolean }): Promise<CapturedWords | undefined>;
}

const MAX_ROWS = 20;

export const pullRequestItemId = (repository: string, number: number): string => `${repository}#pr${String(number)}`;
/** The source id the code-host tap gives a pull request comment or review (codehost.ts `commentId` / the review case). */
export const pullRequestWordsId = (repository: string, number: number, surface: PullRequestSurface, commentId: string): string => `${pullRequestItemId(repository, number)}:${surface}${commentId}`;

/** When the comment was first written, from its first row's version (`created:<the host's time>:<tag>`): epoch milliseconds, or undefined. */
function firstWrittenAt(version: string): number | undefined {
  const start = version.indexOf(":");
  const end = version.lastIndexOf(":");
  if (start < 0 || end <= start) return undefined;
  const at = Date.parse(version.slice(start + 1, end));
  return Number.isFinite(at) ? at : undefined;
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);
const str = (value: unknown, max: number): string | undefined => (typeof value === "string" && value !== "" && value.length <= max ? value : undefined);

export function tableCapturedRows(table: TeamRecordTable, nowSeconds?: () => number): CapturedRowReader {
  async function rows(workspaceId: string, system: string, sourceId: string): Promise<RecordEvent[]> {
    const found = await bySource(table, workspaceId, system, sourceId, MAX_ROWS);
    const events: RecordEvent[] = [];
    for (const item of found.items) {
      const event = eventFromItem(item, nowSeconds?.());
      if (event !== undefined && event.tombstone === undefined && event.workspaceId === workspaceId) events.push(event);
    }
    return events;
  }
  /** A person's words: written by a company member (the row's actor, resolved by the tap), with text. A bot, an outsider or an unlinked account is not. */
  const words = (event: RecordEvent): CapturedWords | undefined => {
    const actor = event.actor;
    if (actor === undefined || actor.developerId === undefined || actor.trust !== "member" || event.trust !== "member") return undefined;
    if (event.text === undefined || event.text.trim() === "") return undefined;
    const line = num(event.structured?.line);
    const path = str(event.structured?.path, 1_000);
    const commitId = str(event.structured?.commitId, 64);
    const side = event.structured?.side === "LEFT" || event.structured?.side === "RIGHT" ? event.structured.side : undefined;
    return {
      id: event.sourceRef.id, authorDeveloperId: actor.developerId, authorSourceId: actor.sourceId, source: event.source, ownText: false, text: event.text, audience: event.audience, scope: event.scope,
      ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }), ...(commitId === undefined ? {} : { commitId }), ...(side === undefined ? {} : { side }),
    };
  };

  return {
    async rememberedNote(input) {
      for (const event of await rows(input.workspaceId, "rovara", `task:${input.taskId}:note:${input.noteId}`)) {
        if (event.kind !== "rovara.remembered" || event.project !== input.project || event.structured?.taskId !== input.taskId) continue;
        const found = words(event);
        if (found !== undefined) return found;
      }
      return undefined;
    },
    async pullRequestWords(input) {
      const wanted = input.surface === "review" ? "github.review" : "github.review_comment";
      const created = input.surface === "review" ? "submitted:" : "created:";
      const all = (await rows(input.workspaceId, input.host, pullRequestWordsId(input.repository, input.number, input.surface, input.commentId)))
        .filter((event) => event.kind === wanted && event.project === input.project && (event.sourceRef.parentId === undefined || event.sourceRef.parentId === pullRequestItemId(input.repository, input.number)));
      for (const event of all) {
        // Only the row of the person who FIRST wrote it: a later edit row holds the words an editor added, which another person may have written.
        if (!(event.sourceRef.version ?? "").startsWith(created)) continue;
        const found = words(event);
        if (found === undefined) continue;
        // The text is the author's own when nobody else has a row on the comment AND it cannot have been changed by someone who has none.
        const onlyAuthor = all.every((row) => row.actor?.developerId === found.authorDeveloperId);
        const writtenAt = firstWrittenAt(event.sourceRef.version ?? "");
        const unchanged = input.surface === "review"
          ? input.edited === false
          : input.edited !== true && input.shownAt !== undefined && writtenAt !== undefined && input.shownAt <= writtenAt;
        return { ...found, ownText: onlyAuthor && unchanged };
      }
      return undefined;
    },
  };
}
