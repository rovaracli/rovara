import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { useDecisions } from "../../api/decisions.js";
import { createPlanPanelApi } from "../../api/plan-panel.js";
import type { DecideSeat } from "../../api/decide-seat.js";
import { cardsFor } from "./task-plain-state.js";
import type { ReadSession } from "./SessionHeader.js";

/**
 * Which seat the viewer decides this task's plan from (approval place, owner decision Q7): the server's `decideAs` in the plan's access summary. It is read only for a viewer who is not the task's owner and
 * only while a decision waits on this task: an owner's seat is the page as it always was, so an owner costs no extra read (the read is the panel's own, shared by its key). Someone else who is shown a
 * decision here is a maintainer, so while the read is out, and if it fails, the page treats them as one (no Reject, no run-limit control): never the other way round. Only a read that came back with no seat
 * (an older server) leaves the page as it was. The owner's name comes from the session when the server did not name it.
 */
export function useTaskSeat(session: ReadSession, taskId: string | undefined): DecideSeat | undefined {
 const host = useAppHost(), api = useMemo(() => createPlanPanelApi(host), [host]), decisions = useDecisions();
 const waiting = cardsFor(decisions.data, taskId).length > 0, enabled = taskId !== undefined && !session.you.owner && waiting;
 const read = useQuery({ queryKey: ["plan-panel", taskId ?? "", "plan"], queryFn: () => api.document(taskId!, "plan"), retry: false, enabled });
 if (!enabled) return undefined;
 const seat = read.data?.access.seat;
 if (read.isSuccess && seat === undefined) return undefined;
 return seat === undefined || seat.as === "maintainer" ? { as: "maintainer", ownerName: seat?.ownerName ?? session.owner.name } : seat;
}
