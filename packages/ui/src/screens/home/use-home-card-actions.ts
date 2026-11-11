import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { createHomeApi, homeAction, type HomeAction, type ReadHomeCard } from "../../api/home.js";
import { ApiError } from "../../api/errors.js";

/**
 * The actions of one older Home card and the code that runs them: the validated buttons (`homeAction`), and what pressing one does (open a page, retry, dismiss, start or drop a waiting ticket),
 * with its busy flag and its error. Both card layouts (today's HomeCard and the new Home's row) use it, so an action is validated and sent in one place. It imports nothing for plain states.
 */
export function useHomeCardActions(card: ReadHomeCard) {
 const host = useAppHost(), api = useMemo(() => createHomeApi(host), [host]), query = useQueryClient();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), sending = useRef(false);
 const actions = card.buttons.flatMap(button => { const action = homeAction(card, button, host.origin);return action === undefined ? [] : [action]; });
 async function run(action: HomeAction) {
  if (sending.current) return;
  if (action.kind === "external" || action.kind === "confirm") { host.openExternal(action.href);return; }
  if (action.kind !== "dismiss" && action.kind !== "retry" && action.kind !== "ticket_start" && action.kind !== "ticket_dismiss") return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   if (action.kind === "ticket_start" || action.kind === "ticket_dismiss") {
    // A waiting ticket's Start or Not this one: the intake client loads only when one is pressed.
    const { createIntakeApi } = await import("../../api/intake.js");
    const answer = await createIntakeApi(host).act(action.href, action.kind === "ticket_start" ? "start" : "dismiss");
    await query.invalidateQueries({ queryKey: ["home"] });
    const started = "started" in answer && answer.started ? SessionIdSchema.safeParse(answer.sessionId) : undefined;
    if (started?.success === true) { host.navigate(paths.session(started.data));return; }
    if ("started" in answer && !answer.started) throw new ApiError(409, "PENDING", answer.state === "started" ? "Someone already started this ticket." : "Rovara couldn't start this ticket yet. Try again later.");
    return;
   }
   if (action.kind === "dismiss") {
    const result = await api.dismissCard(card, action);
    if (result.kind !== "done" || result.value.cardId !== card.cardId) throw new ApiError(409, "PENDING", "This item hasn't been dismissed. Refresh to check its status.");
   } else {
    const result = await api.retry(card, action);
    if (result.kind !== "done") throw new ApiError(409, "PENDING", "This retry is waiting for confirmation. Open the session to continue.");
    await query.invalidateQueries({ queryKey: ["home"] });host.navigate("/app/sessions/" + SessionIdSchema.parse(result.value.session.sessionId));return;
   }
   await query.invalidateQueries({ queryKey: ["home"] });
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't complete this action. Try again."); }
  finally { sending.current = false;setBusy(false); }
 }
 return { actions, busy, error, run };
}
