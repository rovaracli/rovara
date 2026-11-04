// Design review stage, DR10: the broker's own functions behind the wait sweep's ports (`wait-sweep.ts`). Everything that reaches outside the design-review folder (the roster, the project's members, the sign-in table, the
// model keys) is gathered here so the sweep itself reads no store by name and a test gives it fakes. `designWaitSweepOf` is the one call the recovery sweep makes, and it is a no-op until the `dr` switch is on for some project.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DesignReviewBindingSchema, WORKSPACE_PROJECT_INDEX, workspaceProjectIndexValue, type OrgId } from "@agentx/contracts";
import { taskKey, taskPointerKey } from "../developer/task-records.js";
import { queryAllItems } from "../aws/admin-reads.js";
import type { AwsBrokerDependencies } from "../aws/broker/definitions.js";
import { listProjectMembers } from "../org/project-members.js";
import { readApproverRoster } from "../org/second-person-evidence.js";
import type { DesignApproverDirectory } from "./approval.js";
import { readEffectiveDesignReview } from "./setting.js";
import { modelSourceStoreOf } from "../aws/broker/scope-helpers.js";
import { installOrgIdFromEnvironment } from "../org/resolve.js";
import { designReviewStillOn } from "./switch.js";
import { runDesignReviewDpMigration } from "./dp-migration.js";
import { releaseDesignReviewRound } from "./round-record.js";
import { roundRecordPortsOf } from "./wiring.js";
import { sweepDesignWaits, type DesignWaitSweepDeps } from "./wait-sweep.js";
import type { WaitPerson } from "./wait-rows.js";

/** How many of a project's newest workspaces the `dp` move looks at for proof that a design review ran there. */
const PROJECT_TASKS_SCANNED = 25;

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

/**
 * The recovery sweep's one-time move of the old `dp` project list into stored settings (dp-migration.ts). It reads nothing while `dr` is off or `dp` names nothing. Audited as the system; idempotent; removed with `dp`
 * in the next release.
 */
export async function designDpMigrationOf(dependencies: AwsBrokerDependencies): Promise<"off" | "done" | "partial" | "failed"> {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const audit = dependencies.audit === undefined ? {} : { audit: dependencies.audit };
  return runDesignReviewDpMigration({
    playbook: { ...table, now: Date.now, ...audit, edition: dependencies.editionPolicy },
    company: { ...table, now: Date.now, ...audit, edition: dependencies.editionPolicy },
    listOrgs: (after, limit) => modelSourceStoreOf(dependencies).listOrgs(after, limit),
    installOrg: () => { try { return installOrgIdFromEnvironment(); } catch { return undefined; } },
    projectHadDesignReview: projectHadDesignReviewOf(dependencies),
    now: Date.now, log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
  });
}

/** The proof the `dp` move needs for a company with others beside it: the project has a task there that already carries a design review (bounded: its newest 25 workspaces). Another company's task, or another project's, is none. */
export function projectHadDesignReviewOf(dependencies: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }): (orgId: OrgId, project: string) => Promise<boolean> {
  return async (orgId, project) => {
    const workspaces = await dependencies.documentClient.send(new QueryCommand({
      TableName: dependencies.tableName, IndexName: WORKSPACE_PROJECT_INDEX.name, KeyConditionExpression: "#project = :project", ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(orgId, project) }, ScanIndexForward: false, Limit: PROJECT_TASKS_SCANNED,
    })) as { Items?: Array<{ id?: unknown }> };
    for (const workspace of workspaces.Items ?? []) {
      if (typeof workspace.id !== "string") continue;
      const pointer = (await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: taskPointerKey(workspace.id), ConsistentRead: true }))) as { Item?: { taskId?: unknown } };
      if (typeof pointer.Item?.taskId !== "string") continue;
      const task = (await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: taskKey(pointer.Item.taskId), ConsistentRead: true }))) as { Item?: { orgId?: unknown; workflow?: { designReview?: unknown } } };
      if (task.Item?.orgId === orgId && task.Item.workflow?.designReview !== undefined) return true;
    }
    return false;
  };
}
