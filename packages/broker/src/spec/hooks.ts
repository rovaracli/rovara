// K1 lane D, D2: the broker's spec steps, with the effects they need (the store, starting a run, starting a publication) passed in. The wiring (developer-tasks/spec-wiring.ts) supplies the real ones;
// the tests supply fakes. Every state change is conditional on the state's revision and goes with the run it starts in ONE transaction, so there is never a run without its state or a state without its run.
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { agentXError, defaultSpecTarget, type SpecKind, type SpecTarget } from "@agentx/contracts";
import { specIsDue } from "./due.js";
import { buildSpecWriteRequest, type SpecWriteRequest } from "./write-request.js";
import { specLinkLine } from "./link.js";
import { refreshSpecState, type SpecPullRequestFacts } from "./refresh.js";
import {
  SPEC_STATE_SK, SpecStateSchema, continueWithoutSpec, keepEdited, newSpecState, replanEdited, retry, specGate, specGateForReview, specStateKey, startPublishing, startWriting,
  type SpecGate, type SpecState,
} from "./state.js";

export type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** The conditional write of a state: the revision it replaces (none: the item must not exist yet). */
export function specStateItem(tableName: string, next: SpecState, replacesRevision: number | undefined): TransactItem {
  return { Put: {
    TableName: tableName, Item: next,
    ...(replacesRevision === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "#revision = :replaces", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":replaces": replacesRevision } }),
  } };
}

export interface SpecStore {
  /** `corrupt`: an item is there but is not a state this release reads. */
  load(taskId: string): Promise<{ state: SpecState | undefined; corrupt: boolean }>;
  /** Writes `next` over the revision `replaces`; false when another writer moved it first. */
  save(next: SpecState, replaces: number | undefined): Promise<boolean>;
}

export interface SpecTaskRef {
  taskId: string;
  title: string;
  /** The task's `knowledgeCommit` (the meta repo commit its stages read), when it has one. */
  knowledgeCommit: string | undefined;
}

export interface SpecWorld {
  tableName: string;
  now(): string;
  store: SpecStore;
  /** Starts the SPEC_WRITE run. `items(operationId)` are the items that must commit with it. "BUSY": the workspace is not free; nothing was written. */
  startWrite(input: { task: SpecTaskRef; request: SpecWriteRequest; /** Distinct for each attempt (the state's revision), so a repeat of one request is one run and a retry is another. */ attemptKey: string; items: (operationId: string) => TransactItem[] }): Promise<"STARTED" | "BUSY">;
  /** Starts the spec publication to the meta repo. */
  startPublish(input: { task: SpecTaskRef; state: SpecState; attemptKey: string; items: (operationId: string) => TransactItem[] }): Promise<"STARTED" | "BUSY">;
  /** GitHub's view of the spec pull request now (D4); undefined where GitHub cannot say. Absent: the spec pull request is not looked at. */
  readPullRequest?: (state: SpecState) => Promise<SpecPullRequestFacts | undefined>;
  log(event: string, fields: Record<string, string | number | boolean>): void;
}

export interface PlanApproval {
  task: SpecTaskRef;
  planDigest: string;
  kind: SpecKind;
  size?: "small" | "medium" | "large" | undefined;
  requested?: boolean | undefined;
  /** The project's spec target as of the approval (its pinned revision). */
  target: SpecTarget | undefined;
}

export function createSpecHooks(world: SpecWorld) {
  return {
    /**
     * The plan is approved by a person: when a spec is due, its obligation is recorded now, with the target as it is now. Nothing is run here. A task with no `knowledgeCommit` (no meta repo) and a target that
     * writes to the meta repo cannot be given a spec: the state is a failure the owner can continue past, never a silent skip.
     */
    async onPlanApproved(approval: PlanApproval): Promise<"recorded" | "not_due" | "exists"> {
      if (!specIsDue(approval.target, approval)) return "not_due";
      const target = approval.target ?? defaultSpecTarget();
      const existing = await world.store.load(approval.task.taskId);
      // A re-approval after a revise: the same plan keeps its state; a different plan starts a new obligation (the older state is replaced, at its revision).
      if (existing.state !== undefined && existing.state.planDigest === approval.planDigest) return "exists";
      const base = approval.task.knowledgeCommit;
      const fresh = newSpecState({ taskId: approval.task.taskId, planDigest: approval.planDigest, kind: approval.kind, target, knowledgeCommit: base ?? "0".repeat(40), now: world.now() });
      const unsupported = target.where !== "meta_repo" || base === undefined;
      const state = SpecStateSchema.parse({
        ...fresh, revision: (existing.state?.revision ?? 0) + 1,
        ...(unsupported ? { status: "failed", failure: { code: "unsupported", at: world.now() } } : {}),
      });
      const saved = await world.store.save(state, existing.state?.revision);
      world.log("spec.obligation_recorded", { taskId: approval.task.taskId, recorded: saved });
      return saved ? "recorded" : "exists";
    },

    /**
     * What the code pull request does now. Starts the next step itself (write, then publish) and says "hold" while it runs; the step's end writes the state and queues the publication again. `planMarkdown` is read
     * only when a write starts, from the plan whose digest the caller has already checked is the approved one.
     */
    async gate(input: { task: SpecTaskRef; approvedPlanDigest: string; planMarkdown: () => string | undefined; metaRepositoryUrl: string | undefined; /** "review": the code review needs the spec published but not approved. */ purpose?: "review" }): Promise<
      { proceed: true; linkLine?: string } | { proceed: false; hold: Extract<SpecGate, { action: "hold" }> }> {
      // What people did to the spec pull request since (an edit, an approval) is read from GitHub before the decision, so a missed delivery never leaves the code pull request waiting on something already done.
      if (input.purpose !== "review" && world.readPullRequest !== undefined) await refreshSpecState({ store: world.store, now: () => world.now(), read: (state) => world.readPullRequest!(state) }, input.task.taskId).catch(() => undefined);
      const { state, corrupt } = await world.store.load(input.task.taskId);
      const decision = input.purpose === "review" ? specGateForReview(state, corrupt) : specGate(state, corrupt);
      if (decision.action === "proceed") {
        const line = decision.link === undefined || input.metaRepositoryUrl === undefined ? undefined : specLinkLine(decision.link, input.metaRepositoryUrl);
        // A published spec whose link cannot be verified against the meta repo is not described: the pull request opens without a link rather than with one nobody checked... unless the target wants the spec first.
        if (decision.link !== undefined && line === undefined) return { proceed: false, hold: { action: "hold", reason: "failed", message: "The spec pull request is not in the project's meta repository.", ownerActions: ["continue_without_spec"] } };
        return { proceed: true, ...(line === undefined ? {} : { linkLine: line }) };
      }
      if (decision.action === "hold") return { proceed: false, hold: decision };
      const current = state!;
      if (decision.action === "start_write") {
        if (current.planDigest !== input.approvedPlanDigest) return { proceed: false, hold: failHold("plan_changed") };
        const markdown = input.planMarkdown();
        let request: SpecWriteRequest;
        try {
          if (markdown === undefined) throw agentXError("CONFIG_INVALID", "no plan");
          request = buildSpecWriteRequest({ format: current.target.format, kind: current.kind, planDigest: current.planDigest, planMarkdown: markdown, taskTitle: input.task.title, target: current.target });
        } catch {
          await world.store.save(failedState(current, "write_failed", world.now()), current.revision);
          return { proceed: false, hold: failHold("write_failed") };
        }
        await world.startWrite({
          task: input.task, request, attemptKey: String(current.revision),
          items: (operationId) => {
            const next = startWriting(current, operationId, world.now());
            if (next === undefined) throw agentXError("CONFIG_INVALID", "the spec has no write left to start");
            return [specStateItem(world.tableName, next, current.revision)];
          },
        }).catch((error: unknown) => {
          world.log("spec.write_not_started", { taskId: input.task.taskId, error: error instanceof Error ? error.name : "unknown" });
          return "BUSY" as const;
        });
        return { proceed: false, hold: { action: "hold", reason: "writing", message: "Rovara is writing the spec from the approved plan.", ownerActions: [] } };
      }
      // start_publish
      await world.startPublish({
        task: input.task, state: current, attemptKey: String(current.revision),
        items: (operationId) => {
          const next = startPublishing(current, operationId, world.now());
          if (next === undefined) throw agentXError("CONFIG_INVALID", "the spec has nothing to publish");
          return [specStateItem(world.tableName, next, current.revision)];
        },
      }).catch((error: unknown) => {
        world.log("spec.publish_not_started", { taskId: input.task.taskId, error: error instanceof Error ? error.name : "unknown" });
        return "BUSY" as const;
      });
      return { proceed: false, hold: { action: "hold", reason: "publishing", message: "Rovara is opening the spec pull request.", ownerActions: [] } };
    },

    /** The task owner's choice on a held spec. Returns the new state, or undefined when the state was not where the choice expects (nothing changes). */
    async ownerChoice(input: { taskId: string; action: "retry" | "continue_without_spec" | "keep" | "replan"; by: string }): Promise<SpecState | undefined> {
      const { state } = await world.store.load(input.taskId);
      if (state === undefined) return undefined;
      const now = world.now();
      const next = input.action === "retry" ? retry(state, now) : input.action === "keep" ? keepEdited(state, input.by, now) : input.action === "replan" ? replanEdited(state, input.by, now) : continueWithoutSpec(state, input.by, now);
      if (next === undefined) return undefined;
      return (await world.store.save(next, state.revision)) ? next : undefined;
    },
  };
}

const failHold = (code: "plan_changed" | "write_failed"): Extract<SpecGate, { action: "hold" }> => ({
  action: "hold", reason: "failed", message: code === "plan_changed" ? "The approved plan changed since the spec was planned." : "Spec pull request failed: Rovara could not write the spec from the approved plan.", ownerActions: ["continue_without_spec"],
});

function failedState(state: SpecState, code: "write_failed", now: string): SpecState {
  return SpecStateSchema.parse({ ...state, status: "failed", failure: { code, at: now }, revision: state.revision + 1, updatedAt: now });
}

export { SPEC_STATE_SK, specStateKey };
