// Decision cards (Decisions D2/I7): the performer that turns a card's approve or reject into the EXISTING endpoint's own function call, and says truthfully what happened:
//   done (the endpoint decided), needs_confirmation (the endpoint wants the person's confirmation page: nothing was decided), or refused (a fixed reason).
// It adds no authority of its own: the endpoint re-checks the caller's live role, self-approval, second person and idempotency, and the card tier never overrides it (a merge passes the PULL
// REQUEST's risk, never the card's raised tier). A kind with no handler is refused as `unsupported` and listed for wiring: its endpoint lives in a hot file (the workflow plan decision) and is
// mounted by the controller.
import { AgentXError, type DecisionKind, type DecisionRefusalReason } from "@agentx/contracts";
import type { MergePressReply } from "../rovara-code/merge.js";
import type { DecisionCaller, DecisionPerformer, PerformInput, PerformOutcome } from "./routes.js";
import type { DecisionItem } from "./project.js";

export type KindHandler<C extends DecisionCaller> = {
  approve(caller: C, input: PerformInput): Promise<PerformOutcome>;
  reject?(caller: C, input: PerformInput & { reason: string }): Promise<PerformOutcome>;
};

/** A performer from per-kind handlers. A kind without one, or a reject the kind cannot do, is refused (`unsupported`): the person decides on the page. */
export function createDecisionPerformer<C extends DecisionCaller>(handlers: Partial<Record<DecisionKind, KindHandler<C>>>): DecisionPerformer<C> {
  return {
    async approve(caller, input) {
      const handler = handlers[input.card.kind];
      return handler === undefined ? { kind: "refused", reason: "unsupported" } : handler.approve(caller, input);
    },
    async reject(caller, input) {
      const handler = handlers[input.card.kind];
      return handler?.reject === undefined ? { kind: "refused", reason: "unsupported" } : handler.reject(caller, input);
    },
  };
}

/** What an endpoint's own refusal means to the card: only the fixed codes the cards know; anything else is the endpoint's to say and goes on as it is. */
export function refusalOf(error: unknown): DecisionRefusalReason | undefined {
  if (!(error instanceof AgentXError)) return undefined;
  if (error.code === "FORBIDDEN" || error.code === "TASK_ACCESS_DENIED" || error.code === "PROJECT_ACCESS_DENIED") return "forbidden";
  if (error.code === "MERGE_NOT_READY") return /now (low|medium|high)\b/u.test(error.message) || error.message.includes("changed after you confirmed") ? "stale" : "not_ready";
  if (error.code === "CHANGE_STALE" || error.code === "POLICY_STALE") return "stale";
  return undefined;
}

/** Runs an endpoint and maps its refusals; any other error goes on unchanged. */
export async function perform(run: () => Promise<PerformOutcome>): Promise<PerformOutcome> {
  try { return await run(); } catch (error) {
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    return { kind: "refused", reason };
  }
}

type MergeItem = Extract<DecisionItem, { kind: "merge" }>;

/**
 * Merge: `POST /v1/app/sessions/{id}/merge` through `pressMerge`, with the risk the person SAW (the pull request's own level: `item.prRisk`), not the card's tier, and the head of each pull request they were shown (`item.heads`): a push since refuses the press as stale. A 200 is done; a 202 is the
 * confirmation page (a non-browser press such as Slack, and any HIGH-risk press): nothing merged, and no surface may say so.
 */
export function mergeHandler<C extends DecisionCaller>(press: (caller: C, sessionId: string, body: { requestId: string; risk: "low" | "medium" | "high" }, expectedHeads: ReadonlyArray<{ repositoryId: string; number: number; headSha: string }>) => Promise<MergePressReply>): KindHandler<C> {
  return {
    approve: (caller, input) => perform(async () => {
      const item = input.item as MergeItem;
      if (item.kind !== "merge" || item.sessionId === undefined || item.heads === undefined || item.heads.length === 0) return { kind: "refused", reason: "unsupported" };
      const reply = await press(caller, item.sessionId, { requestId: input.requestId, risk: item.prRisk }, item.heads);
      if (reply.status === 200) return { kind: "done" };
      // The pull requests and branches the person was shown (`expectedHeads` made the press refuse any other); an item with none still confirms, without the question's details.
      return { kind: "needs_confirmation", confirmUrl: reply.body.confirmUrl, ...(item.targets === undefined || item.targets.length === 0 ? {} : { merging: item.targets.map((target) => ({ ...target })) }) };
    }),
  };
}

type SpendItem = Extract<DecisionItem, { kind: "approve_spend" }>;

/** Spend: `decideSpendRequest` (APPROVE or DENY) for the request the item names (its subject id). Self-approval, the admin amount and second-person rules are the endpoint's. */
export function spendHandler<C extends DecisionCaller>(decide: (caller: C, spendRequestId: string, body: { requestId: string; decision: "APPROVE" | "DENY" }) => Promise<unknown>): KindHandler<C> {
  const run = (decision: "APPROVE" | "DENY") => (caller: C, input: PerformInput): Promise<PerformOutcome> => perform(async () => {
    const item = input.item as SpendItem;
    if (item.kind !== "approve_spend") return { kind: "refused", reason: "unsupported" };
    await decide(caller, item.subjectId, { requestId: input.requestId, decision });
    return { kind: "done" };
  });
  return { approve: run("APPROVE"), reject: run("DENY") };
}

type TestEnvItem = Extract<DecisionItem, { kind: "approve_test_env" }>;

/**
 * Test environment: `approve` is the setup wizard's own approval (`approveChecked`), for the project and proposal the item names, at the revision the person was shown. It re-reads the proof and the caller's
 * authority; a high-risk or less-safe change has no approve action on its card, and if one is pressed anyway the approval itself refuses it (it needs a fresh sign-in and a second person this press cannot give).
 */
export function testEnvHandler<C extends DecisionCaller>(approve: (caller: C, item: { project: string; digest: string; expectedRevision: number }, requestId: string) => Promise<unknown>): KindHandler<C> {
  return {
    approve: (caller, input) => perform(async () => {
      const item = input.item as TestEnvItem;
      if (item.kind !== "approve_test_env") return { kind: "refused", reason: "unsupported" };
      await approve(caller, { project: item.project, digest: item.subjectId, expectedRevision: item.expectedRevision }, input.requestId);
      return { kind: "done" };
    }),
  };
}

/**
 * A running task's change of test environment: approve moves the task onto the newest revision, "Not now" keeps it on the one it started with and is remembered. `answer` returns "gone" when there is nothing left
 * to confirm (the task ended, the owner changed, the change is not one a running task takes); that is the card's own `stale`.
 */
export function envChangeHandler<C extends DecisionCaller>(answer: (caller: C, taskId: string, answer: "approve" | "decline") => Promise<"moved" | "declined" | "gone">): KindHandler<C> {
  const run = (choice: "approve" | "decline") => (caller: C, input: PerformInput): Promise<PerformOutcome> => perform(async () => {
    const item = input.item;
    if (item.kind !== "confirm_env_change" || item.taskId === undefined) return { kind: "refused", reason: "unsupported" };
    return (await answer(caller, item.taskId, choice)) === "gone" ? { kind: "refused", reason: "stale" } : { kind: "done" };
  });
  return { approve: run("approve"), reject: run("decline") };
}
