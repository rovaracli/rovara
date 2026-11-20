import type { QueryClient } from "@tanstack/react-query";
import { fenceFor as actionFenceFor, useFence as useActionFence } from "../../safe-action.js";
/** Compatibility exports: each action owns its readiness and body-bound fence. */
export { tabSeq, fencedRead, fencedReadiness, observeRecord, type TaskRead, type Fence } from "../../safe-action.js";
export const fenceFor = (client: QueryClient, subject: string) => actionFenceFor(client, subject, "merge");
export const useFence = (subject: string) => useActionFence(subject, "merge");
