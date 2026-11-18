// L4-T1 (G1): the setup's review and approval live in the checklist's Setup run row, so a person finishing setup never has to leave the checklist for the old Setup step. This reads the same setup-agent answer as the Setup step
// (one cache entry) and mounts the same two cards: "What Rovara found" (ConfirmCard) and "Use this setup?" (SetupApprovalCard). Who may do what is the cards' own rule and the server's: the card shows Approve and Reject only to a person
// the read says may give that answer, and "Use this setup" only to a person Code says may manage the run; everyone else reads one line. No new route.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SetupAgentView, SetupDecideReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { useOnboardingApi } from "../../api/onboarding.js";
import { ApiError } from "../../api/errors.js";
import { setupChecklistKey } from "../../api/setup-checklist.js";
import { ConfirmCard } from "./ConfirmCard.js";
import { SetupApprovalCard } from "./SetupApprovalCard.js";
import { APPROVAL_WORDS, REVIEW_WORDS } from "./words.js";

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

export interface SetupReviewState { stage: ReviewStage; view: SetupAgentView | undefined; decided: "approved" | "rejected" | "discarded" | undefined; finished: (reply: SetupDecideReply | "discarded") => void; refetch: () => void; /** A new run was started: what was decided before is no longer news. */ reset: () => void }

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
  return { stage: decided !== undefined && view?.apply === undefined ? "none" : reviewStageOf(view), view, decided, finished, refetch: () => { void query.refetch(); }, reset: () => { setDecided(undefined); void client.invalidateQueries({ queryKey: setupAgentKey(project) }); } };
}

/** The cards themselves, for the Setup run row. */
export function SetupReview({ project, review }: { project: string; review: SetupReviewState }) {
  const { view, stage } = review;
  const onboarding = useOnboardingApi();
  const manage = view?.canManage === true;
  // "Use this setup" proposes against the project's current settings revision (the server refuses a stale one); the run's own base revision is the fallback when the project can't be read.
  const needsRevision = stage === "review" && view?.apply === undefined && manage;
  const projectRead = useQuery({ queryKey: ["onboard", "project", project], queryFn: () => onboarding.project(project), retry: false, enabled: needsRevision });
  const client = useQueryClient();
  if (review.decided !== undefined && stage === "none") return <p role="status" data-testid="setup-decided">{APPROVAL_WORDS[review.decided]}</p>;
  if (view === undefined || stage === "none") return null;
  if (view.apply !== undefined) return <SetupApprovalCard project={project} apply={view.apply} canManage={manage} onDecided={reply => { review.finished(reply); }} onRefresh={review.refetch} />;
  if (!manage) return <p className="rv-muted" role="status" data-testid="setup-review-read-only">{REVIEW_WORDS.readOnly}</p>;
  if (view.proposal === undefined) return null;
  if (projectRead.isPending) return null;
  const revision = projectRead.data?.latestRevision ?? view.basedOnRevision;
  return <ConfirmCard project={project} view={{ ...view, proposal: view.proposal }} settingsRevision={revision} place="checklist" onProposed={() => { void client.invalidateQueries({ queryKey: setupAgentKey(project) }); void client.invalidateQueries({ queryKey: ["onboard", "test-environment", project] }); }} />;
}
