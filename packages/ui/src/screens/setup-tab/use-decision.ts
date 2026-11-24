import { useRef, useState } from "react";
import type { SetupApplyView, SetupDecideReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";

export interface DecisionState {
  busy: "approve" | "reject" | "discard" | undefined;
  done: boolean;
  problem: { message: string; moved: boolean } | undefined;
  decide: (outcome: "approve" | "reject") => Promise<void>;
  discard: () => Promise<void>;
}

/**
 * Approve, don't use, or discard the setup waiting for a decision. One press decides (owner DEC 254zzz73), bound to exactly the revision and digest the read offered (never shown); the same call the old approval card made.
 * The Setup tab keeps this in ONE place so the status card (which holds the primary button) and the "Approve this setup?" card (which holds the details and the problem line) say the same thing.
 */
export function useSetupDecision(project: string, apply: SetupApplyView | undefined, onDecided: (reply: SetupDecideReply | "discarded") => void): DecisionState {
  const api = useSetupAgentApi(), sending = useRef(false);
  const approval = apply?.approval;
  // `done` and `problem` belong to the setup that was decided, not to the tab: they follow the approval the person saw (its id, revision and digest), so a new setup after "Run setup again" can be approved without leaving the tab.
  const target = approval !== undefined ? `${approval.requestId}:${approval.revision}:${approval.artifactDigest}` : apply !== undefined ? "no-approval" : undefined;
  const [doneFor, setDoneFor] = useState<string>(), [busy, setBusy] = useState<DecisionState["busy"]>(), [problemFor, setProblemFor] = useState<{ target: string | undefined; value: NonNullable<DecisionState["problem"]> }>();
  // The setup is gone from the read (decided and cleared): forget it, so the next one with the same shape starts fresh.
  if (target === undefined && doneFor !== undefined) setDoneFor(undefined);
  const done = target !== undefined && doneFor === target;
  const problem = problemFor !== undefined && problemFor.target === target ? problemFor.value : undefined;
  const setProblem = (value: DecisionState["problem"]) => { setProblemFor(value === undefined ? undefined : { target, value }); };
  async function decide(outcome: "approve" | "reject") {
    if (approval === undefined || sending.current) return;
    sending.current = true; setBusy(outcome); setProblem(undefined);
    try {
      const reply = await api.decide(project, { requestId: approval.requestId, outcome, seen: { revision: approval.revision, artifactDigest: approval.artifactDigest } });
      // Decided: nothing more can be pressed while the page reads the project again.
      setDoneFor(target); onDecided(reply);
    } catch (caught) {
      if (caught instanceof ApiError) setProblem({ message: caught.message, moved: caught.code === "CHANGE_STALE" || caught.code === "IDEMPOTENCY_CONFLICT" || caught.code === "PROJECT_REVISION_MISMATCH" });
      else setProblem({ message: "Couldn't send that. Try again.", moved: false });
    } finally { sending.current = false; setBusy(undefined); }
  }
  async function discard() {
    if (sending.current) return;
    sending.current = true; setBusy("discard"); setProblem(undefined);
    try { await api.discard(project, crypto.randomUUID()); setDoneFor(target); onDecided("discarded"); }
    catch (caught) { setProblem({ message: caught instanceof ApiError ? caught.message : "Couldn't discard it. Try again.", moved: caught instanceof ApiError && caught.code === "CHANGE_STALE" }); }
    finally { sending.current = false; setBusy(undefined); }
  }
  return { busy, done, problem, decide, discard };
}
