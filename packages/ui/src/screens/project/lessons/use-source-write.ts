// One source write from the Sources tab: sends it once, reads the lists again after it (always after a stale answer), and keeps the fixed sentence of a failure. Nothing from the server's reply text reaches the screen.
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SourceWriteBodySchema } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { sourcesAdminKey, sourcesReadKey, writeSource, type SourceWriteResult } from "../../../api/record-sources.js";
import { useAppHost } from "../../../host.js";
import { sourceChangeIsStale, sourceFailureText } from "./lessons-text.js";

export function useSourceWrite(project: string) {
 const host = useAppHost(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [reauth, setReauth] = useState(false);
 const reload = async () => { await Promise.all([query.invalidateQueries({ queryKey: sourcesAdminKey(project) }), query.invalidateQueries({ queryKey: sourcesReadKey(project) })]); };
 /** `raw` is the body without a request id; every send gets a fresh one. Resolves to the reply, or undefined after a failure (the sentence is in `error`). */
 async function send(raw: Record<string, unknown>, withRequestId = true): Promise<SourceWriteResult | undefined> {
  if (sending.current) return undefined;
  sending.current = true;setBusy(true);setError(undefined);setReauth(false);
  try {
   const parsed = SourceWriteBodySchema.safeParse(withRequestId ? { ...raw, requestId: crypto.randomUUID() } : raw);
   if (!parsed.success) throw new ApiError(0, "CONFIG_INVALID", "invalid");
   const reply = await writeSource(host, project, parsed.data);
   await reload();
   return reply;
  } catch (failure) {
   setError(sourceFailureText(failure));setReauth(failure instanceof ApiError && failure.code === "REAUTH_REQUIRED");
   if (sourceChangeIsStale(failure)) await reload();
   return undefined;
  } finally { sending.current = false;setBusy(false); }
 }
 const signInAgain = () => { host.signIn(host.currentPath()); };
 return { busy, error, reauth, send, signInAgain, clear: () => { setError(undefined);setReauth(false); } };
}
