import { DeveloperTaskViewReaderSchema, SessionAnchorRefSchema, type SessionAnchorRef } from "@agentx/contracts/web";
import type { ReadSession } from "./SessionHeader.js";
export type ReadTask = ReturnType<typeof DeveloperTaskViewReaderSchema.parse>;
export type CommentOnPart = (anchor: SessionAnchorRef, source: HTMLElement) => void;
export function workspaceTask(session: ReadSession): ReadTask | undefined {
 if (session.body.kind !== "task") return undefined;
 const task = DeveloperTaskViewReaderSchema.safeParse(session.body.task);return task.success ? task.data : undefined;
}
export function visibleAnchor(session: ReadSession, target: SessionAnchorRef["target"], targetId: string): SessionAnchorRef | undefined {
 if (!session.you.actions.includes("comment")) return undefined;
 const found = session.anchors?.find(anchor => anchor.target === target && anchor.targetId === targetId);
 const parsed = SessionAnchorRefSchema.safeParse(found);return parsed.success ? parsed.data : undefined;
}
export const workflowStateWords = (state: string): string => ({ READY: "Ready", RUNNING: "Working", WAITING: "Waiting", BLOCKED: "Needs you", COMPLETE: "Complete" } as Record<string, string>)[state] ?? "Status unavailable";
