import { useEffect, useEffectEvent, useState } from "react";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useAppHost } from "../host.js";
import type { SendResult } from "../api/client.js";
import { isConfirmUrl } from "../text/links.js";
import { CONFIRM_WAIT_MINUTES } from "../constants.js";
import { Button } from "../design/Button.js";
export function ConfirmInBrowser<T>({ result, subjectKey, isApplied }: { result: Exclude<SendResult<unknown>, { kind: "done" }>; subjectKey: QueryKey; isApplied: (data: T) => boolean }) {
 const host = useAppHost(), query = useQueryClient();
 const applied = useEffectEvent((data: T) => isApplied(data));
 const [state, setState] = useState<"waiting" | "done" | "expired">("waiting");
 const key = hashKey(subjectKey);
 useEffect(() => {
 const deadline = setTimeout(() => setState("expired"), CONFIRM_WAIT_MINUTES * 60_000);
 const unsubscribe = query.getQueryCache().subscribe(event => {
 if (event.type !== "updated" || event.query.queryHash !== key || event.action.type !== "success" || event.action.manual === true) return;
 if (applied(event.query.state.data as T)) { clearTimeout(deadline);setState("done"); }
 });
 return () => { clearTimeout(deadline);unsubscribe(); };
 }, [query, key, result]);
 if (state === "done") return <p role="status">Done</p>;
 if (state === "expired") return <p role="status">Nothing changed yet. If you confirmed, reload this page.</p>;
 return <div role="status"><p>{result.kind === "needs_confirmation" ? "Waiting for you to confirm in your browser" : "Waiting for administrator approval"}</p>{result.kind === "needs_confirmation" && result.confirmUrl !== undefined && isConfirmUrl(result.confirmUrl, host.origin) && <Button onClick={() => host.openExternal(result.confirmUrl!)}>Open confirmation</Button>}</div>;
}
