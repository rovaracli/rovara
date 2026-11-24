// The setup run's review state: where a setup of Rovara's waits (nothing, a proposal to review, its check going, a checked candidate to approve), and what was just decided. One read of the setup-agent answer (one cache entry) shared by the
// project page's Setup tab (its status card and cards) and the checklist's one-line Setup run row. Who may do what is the server's rule.
import { useState } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { SetupAgentView, SetupDecideReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { setupChecklistKey } from "../../api/setup-checklist.js";
import { REVIEW_WORDS } from "./words.js";

export const setupAgentKey = (project: string) => ["onboard", "setup-agent", project] as const;
/** The setup-agent read is asked again while a run goes (4 s) or while the candidate's check on a fresh machine goes (5 s). */
export const setupAgentRefetch = (current: { state: { data: SetupAgentView | undefined } }): number | false => (current.state.data?.status === "running" ? 4000 : current.state.data?.apply?.check.status === "checking" ? 5000 : false);

/** Where a setup of Rovara's waits: nothing, a proposal to review, its check going on a fresh machine, a checked candidate to approve (a candidate whose check failed or went stale is "review": the card says why). */
export type ReviewStage = "none" | "review" | "checking" | "approve";
export function reviewStageOf(view: SetupAgentView | undefined): ReviewStage {
  if (view === undefined) return "none";
  if (view.apply !== undefined) return view.apply.check.status === "checking" ? "checking" : view.apply.check.status === "ready" ? "approve" : "review";
  return view.status === "ready" && view.proposal !== undefined ? "review" : "none";
}
export const REVIEW_TEXT: Readonly<Record<Exclude<ReviewStage, "none">, string>> = Object.freeze({ review: REVIEW_WORDS.review, checking: REVIEW_WORDS.checking, approve: REVIEW_WORDS.approve });

export interface SetupReviewState { stage: ReviewStage; view: SetupAgentView | undefined; /** The raw read of the run (the Setup tab tells loading, unavailable and failed apart). */ read: UseQueryResult<SetupAgentView>; decided: "approved" | "rejected" | "discarded" | undefined; finished: (reply: SetupDecideReply | "discarded") => void; refetch: () => void; /** A new run was started: what was decided before is no longer news. */ reset: () => void }

/** One read of the setup run for the checklist. `enabled` is false until the checklist says a run finished; a refusal ("not found", an answer this page can't read) means nothing waits. A decision hides the candidate at once; the next read says what is true. */
export function useSetupReview(project: string, enabled: boolean): SetupReviewState {
  const api = useSetupAgentApi(), client = useQueryClient();
  const query = useQuery({ queryKey: setupAgentKey(project), queryFn: () => api.read(project), retry: false, enabled, refetchInterval: setupAgentRefetch });
  // What was decided, and which run it was about: a run started later (here, on another tab or on the Setup step) is not hidden by it.
  const [decidedAbout, setDecided] = useState<{ word: NonNullable<SetupReviewState["decided"]>; run: string | undefined }>();
  // Only "not found" or an answer this page can't read means nothing waits; a failed re-read keeps the last good answer (the old step shows "Couldn't load" instead; here the row is already saying what the checklist knows).
  const gone = query.error instanceof ApiError && (query.error.status === 404 || query.error.code === "INVALID_RESPONSE");
  const view = enabled && !gone ? query.data : undefined;
  const decided = decidedAbout !== undefined && (view?.startedAt === undefined || decidedAbout.run === view.startedAt) ? decidedAbout.word : undefined;
  function finished(reply: SetupDecideReply | "discarded") {
    setDecided({ word: reply === "discarded" ? "discarded" : reply.decision, run: view?.startedAt });
    void client.invalidateQueries({ queryKey: ["onboard", "project", project] });
    void client.invalidateQueries({ queryKey: ["project", project] });
    void client.invalidateQueries({ queryKey: setupAgentKey(project) });
    void client.invalidateQueries({ queryKey: ["onboard", "test-environment", project] });
    void client.invalidateQueries({ queryKey: ["setup-run", project] });
    void client.invalidateQueries({ queryKey: setupChecklistKey(project) });
  }
  return { stage: decided !== undefined && view?.apply === undefined ? "none" : reviewStageOf(view), view, read: query, decided, finished, refetch: () => { void query.refetch(); }, reset: () => { setDecided(undefined); void client.invalidateQueries({ queryKey: setupAgentKey(project) }); } };
}
