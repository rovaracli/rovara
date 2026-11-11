import { useMemo } from "react";
import type { LookStorageHost } from "../../look.js";
import { useAppHost } from "../../host.js";
/**
 * The agent publishing switch (experience lane exp/agent-publish). This file is the ONLY place that decides whether asking to publish an agent, the approver's list, favourites and suggested agents are on.
 * Today it is a per-device storage key (`rovara.publish` = "v2"), the same cheap switch the new look and the new Home use: no contract change, no broker change. When per-company runtime flags exist, change
 * `isAgentPublishOn` to read the flag and nothing else moves. Off (the default, any other value, unreadable storage) keeps today's agents, builder and Home exactly.
 */
export const AGENT_PUBLISH_STORAGE_KEY = "rovara.publish";
export function isAgentPublishOn(host: LookStorageHost): boolean {
 try { return host.storage.get(AGENT_PUBLISH_STORAGE_KEY) === "v2"; } catch { return false; }
}
export function useAgentPublishOn(): boolean { const host = useAppHost();return useMemo(() => isAgentPublishOn(host), [host]); }
