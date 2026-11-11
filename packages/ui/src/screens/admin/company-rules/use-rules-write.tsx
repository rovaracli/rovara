// One write at a time on the Company rules page: one press, the server's own words on a refusal, a fresh read afterwards. The answer of a write carries the state exactly as a read would, so it replaces the cached state.
import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { companyRulesHistoryKey, companyRulesKey, companyRulesSyncKey, type createCompanyRulesApi } from "../../../api/company-rules.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T } from "./company-rules-text.js";

/** What a write answers: its status and the state exactly as a read gives it. */
export type Answer = Awaited<ReturnType<ReturnType<typeof createCompanyRulesApi>["cancel"]>>;
export type WriteMessage = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };
/** `onStatus` receives the success sentence (and "" when a new write starts), for a page-level status that outlives the section that sent it: after an approval or a disconnect that section is gone. */
export function useRulesWrite(onStatus?: (text: string) => void) {
 const query = useQueryClient(), host = useAppHost(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<WriteMessage>();
 /** Runs the write; true when it was accepted. A second press while one is running is ignored. */
 async function run(write: () => Promise<Answer>, done: string): Promise<boolean> {
  if (sending.current) return false;
  sending.current = true;setBusy(true);setMessage(undefined);onStatus?.("");
  try {
   const answer = await write();
   query.setQueryData(companyRulesKey, answer.state);
   void query.invalidateQueries({ queryKey: companyRulesHistoryKey });void query.invalidateQueries({ queryKey: companyRulesSyncKey });
   if (onStatus === undefined) setMessage({ kind: "status", text: done });else onStatus(done);
   return true;
  } catch (error) {
   if (error instanceof ApiError) {
    // The refusal is shown as the server wrote it. A stale or refused change also re-reads, so the page shows what is true now.
    if (error.code === "CHANGE_STALE" || error.status === 403 || error.status === 404) void query.invalidateQueries({ queryKey: companyRulesKey, exact: true });
    setMessage({ kind: "alert", text: error.message, signIn: error.code === "REAUTH_REQUIRED" });
   } else setMessage({ kind: "alert", text: T.FAILED });
   return false;
  } finally { sending.current = false;setBusy(false); }
 }
 const view: ReactNode = <>
  <p role="status" className="rv-cr-status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <div role="alert" className="rv-cr-alert"><p><VisibleText text={message.text} /></p>{message.signIn === true && <><p className="rv-muted">{T.SIGN_IN_HELP}</p><Button onClick={() => { host.signIn(host.currentPath()); }}>{T.SIGN_IN_AGAIN}</Button></>}</div>}
 </>;
 return { run, busy, view, clear: () => { setMessage(undefined); } };
}
