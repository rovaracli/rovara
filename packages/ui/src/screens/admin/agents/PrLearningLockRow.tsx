import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAppHost } from "../../../host.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { useAdminRead } from "../projects/read.js";

const PATH = "/v1/app/org/agent-guardrails";
/** The document is kept whole: the write sends back every field as the server gave it, so a field this build does not list (the screen's own reader drops them) is never lost. */
const rawReader = z.object({ revision: z.number().int().nonnegative(), guardrails: z.looseObject({ prCommentLearning: z.enum(["allowed", "locked_off"]).optional() }) });
type Waiting = { text: string; changes: string[]; confirmUrl?: string };
const ANYTHING = { parse: (value: unknown) => value };

/** The company lock on learning from PR review comments (design §2.5): "Allowed" (also when the setting is absent) or "Locked off". Locking applies at once; allowing again waits for a company admin. Only an org owner or admin may send it, and the server decides. */
export function PrLearningLockRow() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient(), sending = useRef(false), { role } = useAdminContext();
 const read = useAdminRead("agent-guardrails", "company-pr-learning", PATH, rawReader);
 const [busy, setBusy] = useState(false), [waiting, setWaiting] = useState<Waiting>(), [failure, setFailure] = useState<string>();
 if (read.isPending) return null;
 if (read.data === undefined) return <p role="alert">Couldn't load the setting for learning from PR review comments.</p>;
 const { guardrails, revision } = read.data, locked = guardrails.prCommentLearning === "locked_off", next = locked ? "allowed" : "locked_off";
 async function send() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setFailure(undefined);setWaiting(undefined);
  try {
   const result = await api.send("PUT", PATH, { requestId: crypto.randomUUID(), expectedRevision: revision, guardrails: { ...guardrails, prCommentLearning: next } }, ANYTHING);
   if (result.kind === "needs_confirmation") setWaiting({ text: "Waiting for a company admin to approve", changes: result.changes, ...(result.confirmUrl === undefined ? {} : { confirmUrl: result.confirmUrl }) });
   else if (result.kind === "needs_admin_approval") setWaiting({ text: "Waiting for a company admin to approve", changes: [result.message] });
   await query.invalidateQueries({ queryKey: ["admin", "agent-guardrails"] });
  } catch (error) { setFailure(error instanceof ApiError && error.message !== "" ? error.message : "Couldn't change this setting. Try again."); }
  finally { sending.current = false;setBusy(false); }
 }
 return <div>
  <p>Learning from PR review comments: {locked ? "Locked off" : "Allowed"}</p>
  {(role === "owner" || role === "admin") && <Button busy={busy} onClick={() => { void send(); }}>{locked ? "Allow again" : "Lock off"}</Button>}
  {waiting !== undefined && <div role="status"><p>{waiting.text}</p>{waiting.changes.length > 0 && <ul>{waiting.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul>}{waiting.confirmUrl !== undefined && <p><Button onClick={() => host.openExternal(waiting.confirmUrl!)}>Open confirmation</Button></p>}</div>}
  {failure !== undefined && <p role="alert"><VisibleText text={failure} /></p>}
 </div>;
}
