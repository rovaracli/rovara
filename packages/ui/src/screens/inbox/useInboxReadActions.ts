import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { INBOX_READ_IDS_MAX } from "@agentx/contracts/web";
import { createInboxApi } from "../../api/inbox.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
/** Shared live handlers: exact read route, ids, batching and badge invalidation. */
export function useInboxReadActions(unreadIds: string[], current: boolean) {
 const host = useAppHost(), api = useMemo(() => createInboxApi(host), [host]), query = useQueryClient();
 const [marking, setMarking] = useState(false), [failure, setFailure] = useState<string>();
 const sending = useRef(false), opened = useRef(new Set<string>());
 const refresh = () => Promise.all([query.invalidateQueries({ queryKey: ["inbox", "list"] }), query.invalidateQueries({ queryKey: ["inbox", "badge"] })]);
 const markOne = (id: string) => {
  if (!current || opened.current.has(id)) return;
  opened.current.add(id);
  void api.markRead({ requestId: crypto.randomUUID(), ids: [id] }).then(() => refresh(), error => { if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) opened.current.delete(id);setFailure(error instanceof ApiError ? error.message : "Couldn't mark this as read. Check its status."); });
 };
 async function markAll() {
  if (!current || sending.current || unreadIds.length === 0) return;
  sending.current = true;setMarking(true);setFailure(undefined);
  try {
   for (let start = 0; start < unreadIds.length; start += INBOX_READ_IDS_MAX) await api.markRead({ requestId: crypto.randomUUID(), ids: unreadIds.slice(start, start + INBOX_READ_IDS_MAX) });
  } catch (error) { setFailure(error instanceof ApiError ? error.message : "Couldn't mark these as read. Try again."); }
  finally { sending.current = false;setMarking(false);await refresh(); }
 }
 return { marking, failure, markAll, markOne };
}
