import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";

const NEVER = { retry: "never" } as const;
const ANSWER = { parse: (value: unknown) => value };
/** The words of a held spec's choices (the old review page's fixed words). */
const SPEC_WORDS = { retry: "Try again", continue: "Continue without the spec", keep: "Keep the changes", replan: "Re-plan" } as const;

/**
 * OWNER DECISION 7 items 6 to 8: what the old review page offered on a stopped task, on the task page: Retry the browser and API checks of a blocked round, Revise the plan after coding stopped for the owner's
 * live message, and a held spec's choices. Shown only where the task view offers them (`pageActions`); each press goes to the function the old page and Slack call, which checks who may again.
 */
export function StoppedTaskActions({ task, sessionId }: { task: ReadTask; sessionId: string }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const requestIds = useRef<Record<string, string>>({});
 const offer = task.pageActions, revision = (task.workflow as { revision?: unknown } | undefined)?.revision;
 if (offer === undefined) return null;
 const base = "/v1/app/tasks/" + encodeURIComponent(task.taskId);
 async function press(key: string, path: string, body: Record<string, unknown> | undefined, said: string) {
  if (busy) return;
  setBusy(true);setError(undefined);setDone(undefined);
  try {
   // One press is one request: an answer lost and sent again never acts twice.
   const requestId = requestIds.current[key + ":" + String(revision)] ??= crypto.randomUUID();
   await api.sendAnswer("POST", path, body === undefined ? {} : { ...body, requestId }, ANSWER, NEVER);
   setDone(said);
   await Promise.all([query.invalidateQueries({ queryKey: ["session", sessionId] }), query.invalidateQueries({ queryKey: ["decisions"] })]);
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't do that. Refresh the page and try again."); }
  finally { setBusy(false); }
 }
 const fenced = typeof revision === "number" ? { expectedRevision: revision } : undefined;
 return <section className="rv-stopped-actions" aria-label="What happens next">
  {offer.checksRetry !== undefined && <div><h2>Browser and API checks</h2>{offer.checksRetry.canRetry
   ? <><p>One retry approves the plan again against what is ready now and runs the checks again.</p><Button busy={busy} disabled={fenced === undefined} onClick={() => { void press("checks-retry", base + "/workflow/checks-retry", fenced, "Retrying the browser and API checks."); }}>Retry the browser and API checks</Button></>
   : <p className="rv-muted">Only the task owner can retry these checks.</p>}</div>}
  {offer.revisePlan !== undefined && <div><h2>Revise the plan</h2>{offer.revisePlan.canRevise
   ? <><p>Rovara plans again with the change your live message asked for, and you approve the revised plan before coding continues.</p><Button busy={busy} disabled={fenced === undefined} onClick={() => { void press("revise-plan", base + "/workflow/revise-plan", fenced, "Revising the plan. You approve it before coding continues."); }}>Revise the plan</Button></>
   : <p className="rv-muted">Only the task owner can revise the plan.</p>}</div>}
  {offer.specHold !== undefined && <div><h2><VisibleText text={offer.specHold.title} /></h2><p><VisibleText text={offer.specHold.message} /></p>{offer.specHold.canChoose
   ? <div className="rv-actions">{offer.specHold.choices.filter((choice): choice is keyof typeof SPEC_WORDS => choice in SPEC_WORDS).map(choice => <Button key={choice} busy={busy} onClick={() => { void press("spec-" + choice, base + "/spec/" + choice, undefined, "Done. Rovara goes on from here."); }}>{SPEC_WORDS[choice]}</Button>)}</div>
   : <p className="rv-muted">Only the task owner can choose what happens to the spec.</p>}</div>}
  {done !== undefined && <p role="status">{done}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
