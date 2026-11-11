// Comments pinned to a part of the session (Plan 5 Task 10b). A comment can point at one part of the agent's work: a paragraph of the plan, a step of an agent run, a file in the changes. The
// parts are the ones the session view really has, each with a stable id and a revision, worked out from the task's own view built for the person asking:
//   - `plan_block`: a non-empty paragraph of the plan (`p1`, `p2`, ... in order, at most 200); its revision is `v<newest plan version>`;
//   - `step`: a step of an agent-step run, by its id (at most 100); its revision is the step's status;
//   - `change_file`: a changed file, `<repository>:<path>` (at most 300); its revision is `+<added>-<removed>`.
// OPEN (at the merge of Plans 4 and 5): a chain run's sections now exist (`ChainRunSectionSchema`: one per step attempt, never reordered), but anchors on them are not built yet, so a chain session
// or a session on a Mac still has no part to pin to. Section anchors for chain sessions come later (a `step` target whose id is the section's seq, checked against Plan 4's run view).
//
// Every question is answered against the view built for the CALLER (the owner's view for the effective owner, the viewer's for everybody else), so a part a person can't see is not there for them:
// a write to it is `NOT_FOUND`, and a comment already pinned to it reads as `gone` with no excerpt. `current`, `outdated` and `gone` are worked out on every read from the revision the person was
// looking at against the revision now, the way GitHub marks a review comment outdated after a change. A view that can't be built answers `undefined`: a write is refused, a read says `gone`.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SessionAnchorRefSchema, type AgentSessionRecord, type SessionAnchor, type SessionAnchorRef, type SessionGoneAnchor, type SessionMessage } from "@rovara-code/contracts";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { SessionAccessDependencies } from "./access.js";
import type { SessionReadDependencies } from "./read.js";

const PLAN_BLOCKS_MAX = 200;
const STEPS_MAX = 100;
const FILES_MAX = 300;

/** The part of a task's view the anchors are read from (the rest of the view is not looked at). */
interface AnchorSource {
  workflow?: { planContent?: string | undefined; artifacts?: ReadonlyArray<{ type: string; version: number }> | undefined } | undefined;
  run?: { steps?: ReadonlyArray<{ id: string; status: string }> | undefined } | undefined;
  changedFiles?: ReadonlyArray<{ repository: string; path: string; added: number; removed: number }> | undefined;
}

/** The identity of a part: `<target>:<targetId>`, the spelling `?anchor=` takes. */
export const anchorKey = (anchor: Pick<SessionAnchorRef, "target" | "targetId">): string => `${anchor.target}:${anchor.targetId}`;

/** A blank line (one or more) ends a paragraph. */
const PARAGRAPH_BREAK = /\r?\n(?:[ \t]*\r?\n)+/u;

/** The parts of a task's view a comment can be pinned to, each with its revision now: paragraphs, then steps, then files. A part that can't be given a valid id or revision is left out. */
export function anchorTargetsOf(view: AnchorSource): SessionAnchorRef[] {
  const found: unknown[] = [];
  const planVersion = (view.workflow?.artifacts ?? []).filter((artifact) => artifact.type === "plan").reduce<number | undefined>((newest, artifact) => (newest === undefined || artifact.version > newest ? artifact.version : newest), undefined);
  if (planVersion !== undefined && view.workflow?.planContent !== undefined) {
    const blocks = view.workflow.planContent.split(PARAGRAPH_BREAK).filter((block) => block.trim() !== "").slice(0, PLAN_BLOCKS_MAX);
    blocks.forEach((_, index) => found.push({ target: "plan_block", targetId: `p${String(index + 1)}`, revision: `v${String(planVersion)}` }));
  }
  for (const step of (view.run?.steps ?? []).slice(0, STEPS_MAX)) found.push({ target: "step", targetId: step.id, revision: step.status });
  for (const file of (view.changedFiles ?? []).slice(0, FILES_MAX)) found.push({ target: "change_file", targetId: `${file.repository}:${file.path}`, revision: `+${String(file.added)}-${String(file.removed)}` });
  const seen = new Set<string>();
  const anchors: SessionAnchorRef[] = [];
  for (const candidate of found) {
    const parsed = SessionAnchorRefSchema.safeParse(candidate);
    if (!parsed.success || seen.has(anchorKey(parsed.data))) continue;
    seen.add(anchorKey(parsed.data));
    anchors.push(parsed.data);
  }
  return anchors;
}

export interface AnchorDependencies extends Pick<SessionAccessDependencies, "documentClient" | "tableName"> {
  /** The task's own view, built for the caller; the same function the session view uses. Without it a pinned comment can't be checked. */
  taskView?: SessionReadDependencies["taskView"] | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/**
 * The parts of the session the caller sees now: the view built for them (no events, with details; `owner` only for the session's effective owner). `[]` for a session with no part to pin to (a
 * chain, a session on a Mac); `undefined` when the view can't be built or isn't wired (the caller decides what that means: a write is refused, a read says `gone`). Logs only ids and the error's name.
 */
export async function anchorTargetsFor(deps: AnchorDependencies, session: AgentSessionRecord, caller: { owner: boolean }): Promise<SessionAnchorRef[] | undefined> {
  if (session.subject.kind !== "task") return [];
  if (deps.taskView === undefined) return undefined;
  try {
    const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(session.subject.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
    if (task === undefined || task.orgId !== session.orgId) return undefined;
    return anchorTargetsOf(await deps.taskView(task, { events: 0, details: true, actor: caller.owner ? "owner" : "viewer" }));
  } catch (error) {
    deps.log?.({ event: "agent_session.anchor_view_failed", orgId: session.orgId, sessionId: session.sessionId, error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

/** What a pinned comment's part is now, for the reader whose parts these are: as the person saw it, changed since, or not in their view (or the view could not be read). */
export function anchorStateOf(anchor: Pick<SessionAnchor, "target" | "targetId" | "revision"> | SessionGoneAnchor, targets: readonly SessionAnchorRef[] | undefined): "current" | "outdated" | "gone" {
  if (!("targetId" in anchor)) return "gone";
  const now = targets?.find((entry) => entry.target === anchor.target && entry.targetId === anchor.targetId);
  if (now === undefined) return "gone";
  return now.revision === anchor.revision ? "current" : "outdated";
}

/** An anchor without what it quoted (an anchor that is only a kind has nothing to leave out). */
export const withoutExcerpt = (anchor: SessionAnchor | SessionGoneAnchor): SessionAnchor | SessionGoneAnchor => ("targetId" in anchor ? { target: anchor.target, targetId: anchor.targetId, revision: anchor.revision } : anchor);

/** What a reader who can't see the part reads of its anchor: the kind of part and nothing else (a changed file's id is its path). */
export const goneAnchor = (anchor: Pick<SessionAnchor, "target">): SessionGoneAnchor => ({ target: anchor.target });

/** Whether a stored anchor is on this part. */
export const anchoredOn = (anchor: SessionMessage["anchor"], part: Pick<SessionAnchorRef, "target" | "targetId">): boolean => anchor !== undefined && "targetId" in anchor && anchor.target === part.target && anchor.targetId === part.targetId;

/**
 * The messages as the reader sees them: a pinned comment carries `anchorState` for them, and a `gone` one is reduced to its kind of part (a reader who can't see the part must not read its id, which for a file is its path, or what was quoted from
 * it). The view is built once, and only when some message is pinned; pass `targets` when they were read already.
 */
export async function presentMessages(
  deps: AnchorDependencies, session: AgentSessionRecord, caller: { owner: boolean }, messages: readonly SessionMessage[], targets?: readonly SessionAnchorRef[],
): Promise<SessionMessage[]> {
  if (!messages.some((message) => message.anchor !== undefined)) return [...messages];
  const now = targets ?? await anchorTargetsFor(deps, session, caller);
  return messages.map((message) => {
    if (message.anchor === undefined) return message;
    const anchorState = anchorStateOf(message.anchor, now);
    return { ...message, anchor: anchorState === "gone" ? goneAnchor(message.anchor) : message.anchor, anchorState };
  });
}
