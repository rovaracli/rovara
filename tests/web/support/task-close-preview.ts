// Wire examples from D-CORE 114c95be2 task-close-preview.ts and CloseIntentSchema.
export const CLOSE_TASK_ID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
export const CLOSE_REQUEST_ID = "ABCDEF12-3333-4333-8333-33333333ABCD";
export const CLOSE_DIGEST = "0123456789abcdef".repeat(4);
export const closePreview = (action: "close" | "discard" = "close") => ({ preview: {
 action, taskId: CLOSE_TASK_ID, digest: CLOSE_DIGEST, taskStatus: "RUNNING" as const,
 workflow: { revision: 7, stage: "BUILD", state: "BLOCKED" },
 workspace: { status: "READY" as const, fence: 4, activeOperationId: null },
 unpublished: [{ repository: "demo", reasons: ["worktree_changes" as const, "untracked_files" as const, "unpushed_head" as const, "unpushed_branch" as const] }],
 inspection: { operationId: "33333333-3333-4333-8333-333333333333", workspaceFence: 4, contentDigest: "b".repeat(64) },
} });
export const RETAINED_CLOSE_REFUSAL = { error: { code: "WORKSPACE_BUSY", message: `This workspace is retained. Review the Close preview at /v1/dev/tasks/${CLOSE_TASK_ID}/close before closing it.` } };
