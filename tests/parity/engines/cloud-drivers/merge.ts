// Cloud drivers: merge tracking, branch sync, merge conflicts (areas 12, 41).
//
// Merge tracking, branch sync and conflict fixes run on Cloud's Rovara Code version 2 path (workflow definition 1.1.0 with a program), which is the path
// the core always runs (its tasks are 1.1.0). The journey harness starts tasks on version 1, so these drivers move the task to version 2 the way the
// branch-sync journeys do (tests/integration/workflow-e2e/15-branch-sync.test.ts `waitingForMerge`): the definition version at the plan review, and
// the program once the pull request is open. GitHub's side is the harness's `trackingGithub` seam (merge-support/cloud-github.ts).
import { CONFLICT_PATHS_BLOCK_HEADER, type WorkflowProgram } from "@rovara-code/contracts";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import { baseOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import type { WorkflowE2E } from "../../../support/workflow-e2e.js";
import type { Scenario } from "../../harness/types.js";
import { trackingGithub, type TrackingGithubState } from "../merge-support/cloud-github.js";

type Driver = StepDriver<CloudContext, CloudOptions>;

/** The program Cloud's version 2 tasks run (the one of the branch-sync journeys). */
const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };

/** The coder's answer to a conflict: the base's greeting and the change, joined (the content does not matter to the comparison, only that it is resolved). */
const RESOLVED = "export function greet(name: string): string {\n  return `Hi, ${name}`;\n}\n";
/** What the base gets when it moves: a file the change does not touch (drift), or the file the change touches (a conflict). */
const UPSTREAM = { path: "upstream.ts", content: "export const upstream = 1;\n" };
const CONFLICTING = { path: "greeting.ts", content: "export function greet(name: string): string {\n  return 'Hi ' + name;\n}\n" };

interface MergeState { holder: { e2e?: WorkflowE2E }; github: TrackingGithubState }
const states = new WeakMap<Scenario, MergeState>();

function shared(): Pick<Driver, "options" | "prepare"> {
  return {
    options(scenario) {
      if (states.has(scenario)) return {};
      const holder: { e2e?: WorkflowE2E } = {};
      const github = trackingGithub(() => holder.e2e!);
      states.set(scenario, { holder, github: github.state });
      const base = baseOptions(scenario).model!;
      const edits = base.edits as Array<{ path: string; content: string }>;
      return {
        trackingGithub: github.methods,
        model: { ...base, edits: (latest: string) => (latest.includes(CONFLICT_PATHS_BLOCK_HEADER) ? [{ path: "repo/demo/greeting.ts", content: RESOLVED }] : edits) },
      };
    },
    async prepare(ctx, scenario) {
      const state = states.get(scenario)!;
      if (state.holder.e2e !== undefined) return;
      state.holder.e2e = ctx.e2e;
      // Version 2 from the plan review on (as the branch-sync journeys set it), and its program once the pull request is open. Seeding writes (`set`) are not
      // reported to the listener, so this changes the task without a recorded transition of its own.
      let versioned = false;
      let programmed = false;
      ctx.e2e.db.onWrite((change) => {
        const item = change.after;
        if (item === undefined || !String(item.pk).startsWith("DEVTASK#") || item.sk !== "META") return;
        const workflow = item.workflow as { stage?: string; state?: string } | undefined;
        if (!versioned && workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
          versioned = true;
          ctx.e2e.db.set({ ...item, workflow: { ...(item.workflow as object), definitionVersion: "1.1.0" } });
        }
        if (!programmed && workflow?.stage === "WAIT_FOR_MERGE") {
          programmed = true;
          ctx.e2e.db.set({ ...item, workflow: { ...(item.workflow as object), program: PROGRAM, programStepId: "pull_request" } });
        }
      });
    },
  };
}

/** The schedule's tracking pass, then the dispatch sweep and the worker, until the task is quiet (`trackAndRun` of the branch-sync journeys). */
async function trackAndRun(ctx: CloudContext, rounds = 6): Promise<void> {
  // A quiet task is looked at again at the heartbeat; a webhook would wake it sooner.
  ctx.e2e.clock.advance(16 * 60_000);
  await ctx.e2e.runMergeRecovery();
  for (let round = 0; round < rounds; round += 1) {
    await ctx.e2e.runRecovery();
    await ctx.e2e.settle();
  }
}

function stateOf(ctx: CloudContext): TrackingGithubState {
  return states.get(ctx.scenario)!.github;
}

export const MERGE_DRIVERS: Record<string, Driver> = {
  // Cloud's automatic fix switch (`af`) on for this scenario (the journey harness has it off). A setting, so the step itself does nothing.
  "feature:autofix-on": {
    options: () => ({ autofix: { enabled: true, capUsd: 5, roundEstimateUsd: 1 } }),
    run: () => Promise.resolve(),
  },
  "pr.merged": {
    ...shared(),
    async run(ctx) {
      // The first tracking pass marks the draft ready (the person approved on GitHub), then the person merges it and GitHub's webhook says so.
      await trackAndRun(ctx, 1);
      const number = ctx.e2e.github.pullRequests[0]!.number;
      ctx.e2e.github.merge(number);
      if (await ctx.e2e.githubWebhook(number, { merged: true }) !== 200) throw new Error("Cloud refused the merged webhook");
      await ctx.e2e.settle();
    },
  },
  "base.moved": {
    ...shared(),
    async run(ctx) {
      await trackAndRun(ctx, 1);
      await ctx.e2e.advanceBase(UPSTREAM.path, UPSTREAM.content);
      stateOf(ctx).baseAhead = true;
      await trackAndRun(ctx);
      ctx.extra.codeHost.push(...ctx.e2e.github.pushLog.filter((push) => push.during === "maintain").map(() => "push_base_merge"));
    },
  },
  "merge.conflict": {
    ...shared(),
    async run(ctx) {
      await trackAndRun(ctx, 1);
      await ctx.e2e.advanceBase(CONFLICTING.path, CONFLICTING.content);
      stateOf(ctx).conflicted = true;
      await trackAndRun(ctx);
      ctx.extra.codeHost.push(...ctx.e2e.github.pushLog.filter((push) => push.during === "maintain").map(() => "push_conflict_fix"));
    },
  },
};
