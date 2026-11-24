// The Setup tab's reads, in one place. The project page calls this once (its header chip and the tab both draw from it), so the status card, the address list, the run and the limits agree. Every read is the
// one the old page already made, under the same key: the checklist, the setup run (with its review stage), the run's journal, the repair read, the project's limits and who the person is.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSetupChecklist, SetupAgentView, SetupJournalReply } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { servedReadState } from "../../api/served-read.js";
import { useOnboardingApi } from "../../api/onboarding.js";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { checklistAbsent, setupChecklistKey, useSetupChecklistApi } from "../../api/setup-checklist.js";
import { setupLimitsKey, useSetupLimitsApi, type ProjectLimits } from "../../api/setup-limits.js";
import { setupRepairKey, useSetupRepairApi, type SetupRepairView } from "../../api/setup-repair.js";
import { journalKey } from "../setup/journal-key.js";
import { useSetupReview, type SetupReviewState } from "../setup/SetupReview.js";
import type { Decisions } from "./AddressAsks.js";
import { statusCardOf, type StatusCardModel } from "./setup-card.js";

/** What the limits read keeps when Code does not serve the limits at all (Cloud's fixed 501 NOT_ON_CODE_YET, or Code's own route-not-found 404): kept for ten minutes, so a page that remounts does not ask again every few seconds. */
export const NOT_SERVED = "not_served" as const;
export function useProjectLimits(project: string, enabled: boolean) {
  const api = useSetupLimitsApi();
  return useQuery({
    queryKey: setupLimitsKey(project), enabled,
    queryFn: async (): Promise<ProjectLimits | typeof NOT_SERVED> => {
      try { return await api.project(project); }
      catch (error) { if (error instanceof ApiError && (error.status === 404 || (error.status === 501 && error.code === "NOT_ON_CODE_YET"))) return NOT_SERVED; throw error; }
    },
    retry: false, refetchOnWindowFocus: false, staleTime: 10 * 60_000,
  });
}
/** A limits read that says "not for you" or "not here": the section is absent. */
export const limitsHidden = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || error.status === 403 || (error.status === 501 && error.code === "NOT_ON_CODE_YET"));

export const canManageRun = (view: SetupAgentView | undefined): boolean => view !== undefined && (view as { canManage?: unknown }).canManage === true;

/**
 * When the state the header names happened: the approval for a setup in use, else when the run ended (its start plus the time it took), else its start (a run that is going).
 * The header says "Setup is verified · 40m ago": that is the time of the verifying, never of the run's start.
 */
export function stateTime(data: Pick<SetupTabData, "run" | "checklist">): number | undefined {
  const row = data.checklist?.setupRun, run = data.run;
  const instant = (text: string | undefined): number | undefined => { const at = text === undefined ? Number.NaN : Date.parse(text); return Number.isFinite(at) ? at : undefined; };
  // A newer setup waiting beside the one in use is dated by its own run, not by the old approval.
  const approved = row?.approval === "approved" && row.newerProposal === undefined ? instant(row.approvedAt) : undefined;
  if (approved !== undefined) return approved;
  const start = instant(run?.startedAt ?? row?.startedAt);
  if (start === undefined || run?.status === "running") return start;
  const ms = row?.elapsedMs ?? run?.summary?.elapsedMs;
  return ms === undefined ? start : start + ms;
}

export interface SetupTabData {
  review: SetupReviewState;
  checklist: ProjectSetupChecklist | undefined;
  run: SetupAgentView | undefined;
  journal: SetupJournalReply | undefined;
  journalState: ReturnType<typeof useQuery<SetupJournalReply>>;
  limits: ProjectLimits | undefined;
  limitsRead: ReturnType<typeof useProjectLimits>;
  repair: SetupRepairView | undefined;
  company: string | undefined;
  /** Nothing is known yet: the first read of the run has not answered. */
  pending: boolean;
  /** Code (through Cloud) does not serve the setup run at all. */
  unavailable: boolean;
  model: StatusCardModel | undefined;
  decisions: Decisions;
  setDecisions: (change: (now: Decisions) => Decisions) => void;
  refresh: () => void;
}

/** `enabled`: the project page is ready. `onTab`: the Setup tab is open (the journal and the limits are read for it; the header chip needs only the run). */
export function useSetupTab(project: string, options: { enabled: boolean; onTab: boolean; /** The person may start work in this project (the overview says so): Start a task is then the primary of a verified setup. */ canStartWork?: boolean }): SetupTabData {
  const { enabled, onTab } = options;
  // The address decisions that went through in this view are kept here (not in a list that a failed re-read can wipe).
  const [decisions, setDecisions] = useState<Decisions>({});
  const checklistApi = useSetupChecklistApi(), agent = useSetupAgentApi(), repairApi = useSetupRepairApi(), onboarding = useOnboardingApi(), client = useQueryClient();
  const checklist = useQuery({ queryKey: setupChecklistKey(project), queryFn: () => checklistApi.status(project), retry: false, enabled, refetchInterval: current => (current.state.data?.setupRun.state === "running" || current.state.data?.setupRun.newerProposal === "checking" ? 5000 : false) });
  const review = useSetupReview(project, enabled);
  const run = review.read;
  const wantJournal = enabled && (onTab || review.view?.stop === "hosts_waiting");
  const journalState = useQuery({ queryKey: journalKey(project), queryFn: () => agent.journal(project, { retry: "never" }), retry: false, enabled: wantJournal, refetchInterval: review.view?.status === "running" ? 3000 : false });
  const repair = useQuery({ queryKey: setupRepairKey(project), queryFn: () => repairApi.read(project), retry: false, refetchOnWindowFocus: false, enabled });
  const limitsRead = useProjectLimits(project, enabled && onTab);
  const me = useQuery({ queryKey: ["me"], queryFn: onboarding.me, enabled, retry: false });
  const journal = servedReadState(journalState).data;
  const limitsValue = limitsRead.data === NOT_SERVED ? undefined : limitsRead.data;
  const company = me.data?.org.name;
  const unavailable = run.isError && (checklistAbsent(run.error) || (run.error instanceof ApiError && run.error.code === "INVALID_RESPONSE"));
  const pending = enabled && run.isPending;
  const view = review.view ?? (run.isError ? undefined : run.data);
  const row = checklist.data?.setupRun;
  const companyRole = checklist.data?.viewer.companyRole ?? me.data?.developer.orgRole;
  const model = enabled && !pending && !unavailable ? statusCardOf({
    project, company, row, run: view, stage: review.stage, asks: journal?.hostAsks,
    limits: limitsValue === undefined ? undefined : { budgetCents: limitsValue.effective.budgetCents, wallClockMin: limitsValue.effective.wallClockMin, hostAsks: limitsValue.effective.hostAsks },
    repair: repair.data, decided: review.decided, mayAct: canManageRun(view), mayStartTask: options.canStartWork === true || checklist.data?.firstTask.canStart === true, decidedHere: Object.keys(decisions).length,
    companyAdmin: companyRole === "owner" || companyRole === "admin",
  }) : undefined;
  return {
    review, checklist: checklist.data, run: view, journal, journalState, limits: limitsValue, limitsRead, repair: repair.data, company, pending, unavailable, model, decisions, setDecisions,
    refresh: () => {
      void client.invalidateQueries({ queryKey: setupChecklistKey(project) });
      void client.invalidateQueries({ queryKey: ["onboard", "setup-agent", project] });
      void client.invalidateQueries({ queryKey: journalKey(project) });
      void client.invalidateQueries({ queryKey: setupRepairKey(project) });
      void client.invalidateQueries({ queryKey: ["setup-run", project] });
    },
  };
}
