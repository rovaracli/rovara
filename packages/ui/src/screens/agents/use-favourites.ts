import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_FAVOURITES, MY_AGENTS_KEY, useAgentPublishApi, useMyAgents, type ReadMyAgents } from "../../api/agent-publish.js";
import { ApiError } from "../../api/errors.js";
import { useAnnounce } from "../../design/Announcer.js";
import { toggledFavourites } from "./publish-words.js";

/**
 * Favourite agents: the person's own ordered list, read and written whole (`PUT /v1/app/me/agents/favourites` with the revision it was read at). `toggle` adds an agent at the end or removes it.
 * A list changed somewhere else (a stale revision) is read again and the person is told to try once more; a full list says so. The answer replaces the cached list at once, so every star on the page agrees.
 */
export function useFavourites() {
 const read = useMyAgents(), api = useAgentPublishApi(), query = useQueryClient(), announce = useAnnounce(), sending = useRef(false);
 const [busyId, setBusyId] = useState<string>(), [error, setError] = useState<{ agentId: string; message: string }>();
 const data = read.isError ? undefined : read.data, ids = data?.favourites.map(card => card.agentId) ?? [];
 async function toggle(agentId: string, name: string) {
  if (sending.current || data === undefined) return;
  const adding = !ids.includes(agentId);
  if (adding && ids.length >= Math.min(MAX_FAVOURITES, data.limits.maxFavourites)) { setError({ agentId, message: `You can have up to ${String(data.limits.maxFavourites)} favourites. Remove one first.` });return; }
  sending.current = true;setBusyId(agentId);setError(undefined);
  try {
   const result = await api.setFavourites(toggledFavourites(ids, agentId), data.revision);
   query.setQueryData<ReadMyAgents>([MY_AGENTS_KEY, undefined], old => old === undefined ? old : { ...old, favourites: result.favourites, revision: result.revision });
   announce(adding ? `${name} added to your favourites` : `${name} removed from your favourites`);
   await query.invalidateQueries({ queryKey: [MY_AGENTS_KEY] });
  } catch (failure) {
   if (failure instanceof ApiError && failure.code === "CHANGE_STALE") { await query.invalidateQueries({ queryKey: [MY_AGENTS_KEY] });setError({ agentId, message: "Your favourites changed somewhere else. Try again." }); }
   else setError({ agentId, message: failure instanceof ApiError ? failure.message : "Couldn't change your favourites. Try again." });
  } finally { sending.current = false;setBusyId(undefined); }
 }
 return { ready: data !== undefined, pending: read.isPending, ids, toggle, busyId, error, data };
}
