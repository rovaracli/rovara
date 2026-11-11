import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DeveloperTaskViewSchema, LoadedKnowledgeResponseReaderSchema, LoadedKnowledgeTextReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";

const taskPath = (taskId: string) => "/v1/app/tasks/" + encodeURIComponent(DeveloperTaskViewSchema.shape.taskId.parse(taskId)) + "/loaded-knowledge";

/** The stage records of a task. Fetched only while `enabled`, so a closed panel costs nothing. */
export function useLoadedKnowledge(taskId: string, enabled: boolean) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["task", taskId, "loaded-knowledge"], enabled, queryFn: () => api.get(taskPath(taskId), LoadedKnowledgeResponseReaderSchema) });
}

/** The text of one listed rule file, fetched when someone asks for it (the server checks they can read the repository). */
export function useLoadedKnowledgeText(taskId: string, target: { operationId: string; stage: string; index: number } | undefined) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({
  queryKey: ["task", taskId, "loaded-knowledge", target?.operationId, target?.stage, target?.index], enabled: target !== undefined, retry: false,
  queryFn: () => api.get(taskPath(taskId) + "/" + encodeURIComponent(target!.operationId) + "/" + encodeURIComponent(target!.stage) + "/items/" + String(target!.index) + "/text", LoadedKnowledgeTextReaderSchema),
 });
}
