// Design review stage, DR10: the broker's own functions behind the wait sweep's ports (`wait-sweep.ts`). Everything that reaches outside the design-review folder (the roster, the project's members, the sign-in table, the
// model keys) is gathered here so the sweep itself reads no store by name and a test gives it fakes. `designWaitSweepOf` is the one call the recovery sweep makes, and it is a no-op until the `dr` switch is on for some project.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DesignReviewBindingSchema, type OrgId } from "@rovara-code/contracts";
import { queryAllItems } from "../aws/admin-reads.js";
import type { AwsBrokerDependencies } from "../aws/broker/definitions.js";
import { listProjectMembers } from "../org/project-members.js";
import { readApproverRoster } from "../org/second-person-evidence.js";
import type { DesignApproverDirectory } from "./approval.js";
import { readEffectiveDesignReview } from "./setting.js";
import { designReviewStillOn } from "./switch.js";
import { releaseDesignReviewRound } from "./round-record.js";
import { roundRecordPortsOf } from "./wiring.js";
import { sweepDesignWaits, type DesignWaitSweepDeps } from "./wait-sweep.js";
import type { WaitPerson } from "./wait-rows.js";

/** The rounds whose keys are released when a review is parked or closed: the latest two (a review has at most two rounds), newest last. */
const ROUNDS_RELEASED = 2;

export function designWaitSweepDepsOf(dependencies: AwsBrokerDependencies): DesignWaitSweepDeps {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const signInTableName = dependencies.developer?.signInTableName;
  return {
    ...table, now: Date.now, enabledFor: (orgId, project, decidedBy) => designReviewStillOn(table, orgId, project, decidedBy), edition: dependencies.editionPolicy, log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    setting: async (orgId, project) => (await readEffectiveDesignReview(table, orgId, project)).setting,
    // The shared roster (maintainers, admins and owners whose identity is live) and the project's people: the same live evidence a second-person decision reads. Groups are not read here: a reminder for a group approver falls
    // back to the maintainers, and what a person may DO is still decided by the handlers when they act.
    directory: async ({ orgId, project }): Promise<DesignApproverDirectory | undefined> => {
      if (signInTableName === undefined) return undefined;
      try {
        const [roster, members] = await Promise.all([readApproverRoster({ ...table, signInTableName, now: Date.now }, { orgId, project }), listProjectMembers(table, orgId, project)]);
        return {
          people: roster,
          projectMemberIds: members.filter((member) => member.role === "maintainer" || member.role === "contributor").map((member) => member.developerId),
          notApproverIds: members.filter((member) => member.role === "viewer").map((member) => member.developerId),
        };
      } catch { return undefined; }
    },
    people: async (_orgId: OrgId, ids): Promise<ReadonlyMap<string, WaitPerson>> => {
      const found = new Map<string, WaitPerson>();
      if (signInTableName === undefined) return found;
      for (const id of ids) {
        const record = (await dependencies.documentClient.send(new GetCommand({ TableName: signInTableName, Key: { pk: `DEVELOPER#${id}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
        if (record === undefined || record["revoked"] === true) continue;
        const slackUserId = record["slackUserId"];
        found.set(id, { name: typeof record["displayName"] === "string" && record["displayName"] !== "" ? record["displayName"] : "A teammate", ...(typeof slackUserId === "string" && slackUserId !== "" ? { slackUserId } : {}) });
      }
      return found;
    },
    // Block and finalize the keys of the task's design-review rounds (the proxy counts what it had admitted, the ledger drops the unspent hold) and remove their stored packets. Idempotent, so a round already recorded is a no-op.
    releaseKeys: async (task, throughRound) => {
      try {
        const ports = roundRecordPortsOf(dependencies);
        const operations = (await queryAllItems(table, `WORKSPACE#${task.workspaceId}`, "OPERATION#"))
          .filter((item) => item["entityType"] === "OPERATION" && item["kind"] === "task" && item["workflowMode"] === "PLAN_CRITIQUE" && item["designReview"] !== undefined && DesignReviewBindingSchema.safeParse(item["designReview"]).success)
          .sort((left, right) => String(left["createdAt"]).localeCompare(String(right["createdAt"]))).slice(-ROUNDS_RELEASED);
        for (const operation of operations) {
          const binding = DesignReviewBindingSchema.parse(operation["designReview"]);
          // A round that began after the task was read is a later round's (ON-8): its live keys are left alone.
          if (binding.round > throughRound) continue;
          if (typeof operation["orgId"] === "string") await releaseDesignReviewRound(ports, { id: String(operation["id"]), orgId: operation["orgId"], designReview: binding });
        }
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "design_review.wait_keys_not_released", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
      }
    },
  };
}

/**
 * The recovery sweep's design-wait step. It runs with the `dr` switch off too (ON-7): then `enabledFor` is false for every project, so the sweep does only its switched-off work (it ends the cost holds as not run,
 * `switched_off`, parked ones included) and starts no reminder, park or close. With nothing waiting it is one read of an index partition that holds no rows.
 */
export async function designWaitSweepOf(dependencies: AwsBrokerDependencies): Promise<{ attempted: number }> {
  return sweepDesignWaits(designWaitSweepDepsOf(dependencies));
}
