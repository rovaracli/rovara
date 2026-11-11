import { useMemo } from "react";
import type { LookStorageHost } from "../../look.js";
import { useAppHost } from "../../host.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The agent publishing switch (experience lane exp/agent-publish). This file is the ONLY place that decides whether asking to publish an agent, the approver's list, favourites and suggested agents are on.
 * Today it is a per-device storage key (`rovara.publish` = "v2"), the same cheap switch the new look and the new Home use: no contract change, no broker change. Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer. Off (the default, any other value, unreadable storage) keeps today's agents, builder and Home exactly.
 */
export const AGENT_PUBLISH_STORAGE_KEY = "rovara.publish";
export function isAgentPublishOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "publish", AGENT_PUBLISH_STORAGE_KEY);
}
export function useAgentPublishOn(): boolean { const host = useAppHost();return useMemo(() => isAgentPublishOn(host), [host]); }
