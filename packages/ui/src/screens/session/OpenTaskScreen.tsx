import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { createSessionApi } from "../../api/sessions.js";
import { useAppHost } from "../../host.js";
import { NotFound } from "../../shell/NotFound.js";
import { Skeleton } from "../../design/Skeleton.js";
/**
 * `/t/<taskId>` (K2): a link to a task by its Code id, which is how a person Code lets read a task they did not start (a People co-owner, commenter or
 * viewer) is sent to it. Cloud finds the task's session or makes it, only after Code lets this person read the task; the page then goes to `/s/<session>`.
 * A refusal, an unreadable answer and a task that is not there all read the same: "not found".
 */
export function OpenTaskScreen() {
 const taskId = useParams().taskId ?? "", host = useAppHost(), api = useMemo(() => createSessionApi(host), [host]), [missing, setMissing] = useState(false);
 useEffect(() => {
  let current = true;
  api.openTask(taskId).then(sessionId => { if (!current) return;if (sessionId === undefined) setMissing(true);else host.navigate("/s/" + sessionId); }, () => { if (current) setMissing(true); });
  return () => { current = false; };
 }, [api, host, taskId]);
 return missing ? <NotFound /> : <section data-testid="open-task" aria-busy="true"><h1 tabIndex={-1}>Opening the task</h1><Skeleton /></section>;
}
